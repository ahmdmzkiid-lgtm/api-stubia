const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const midtrans = require('../services/midtransService');

// ─── GET /plans ─── list all active plans
router.get('/plans', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, display_name, description, price, original_price, discount_percent, duration_days, features, is_popular, sort_order, plan_type, target_type, quota_limit
       FROM plans WHERE is_active = true ORDER BY sort_order`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /my-subscription ─── current user's active sub
router.get('/my-subscription', verifyToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS plan_name, p.display_name, p.price, p.features
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
       ORDER BY s.expires_at DESC LIMIT 1`,
      [req.user.id]
    );
    const sub = rows[0] || null;
    res.json({ success: true, data: sub });
  } catch (err) {
    next(err);
  }
});

// ─── GET /active-plans ─── all active subscriptions for current user
router.get('/active-plans', verifyToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.plan_id, s.status, s.expires_at, s.quota_remaining,
              p.name, p.display_name, p.plan_type, p.target_type, p.quota_limit
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1 AND s.status = 'active' AND s.expires_at > NOW()
       ORDER BY s.expires_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /midtrans-client-key ─── return client key for Snap.js
router.get('/midtrans-client-key', verifyToken, (req, res) => {
  res.json({ success: true, clientKey: midtrans.getClientKey() });
});

// ─── POST /subscribe ─── create payment transaction
router.post('/subscribe', verifyToken, async (req, res, next) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ success: false, error: 'planId is required' });

    // Get plan
    const planResult = await pool.query('SELECT * FROM plans WHERE id = $1 AND is_active = true', [planId]);
    const plan = planResult.rows[0];
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });

    // Free plan → activate directly
    if (plan.price === 0) {
      // Cancel existing active subs
      await pool.query(
        `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`,
        [req.user.id]
      );

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + plan.duration_days);

      await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id, status, expires_at) VALUES ($1, $2, 'active', $3)`,
        [req.user.id, plan.id, expiresAt]
      );

      await pool.query(`UPDATE users SET current_plan = $1 WHERE id = $2`, [plan.name, req.user.id]);

      return res.json({ success: true, message: 'Paket Gratis diaktifkan', data: { plan: plan.name } });
    }

    // Paid plan → create Midtrans transaction with PPN 11%
    const taxAmount = Math.round(plan.price * 0.11);
    const finalAmount = plan.price + taxAmount;
    const orderId = `STB-${Date.now()}-${uuidv4().slice(0, 8)}`;

    // Get user info
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    const itemDetails = [
      {
        id: plan.id,
        price: plan.price,
        quantity: 1,
        name: plan.display_name.slice(0, 50),
      },
      {
        id: 'TAX-PPN11',
        price: taxAmount,
        quantity: 1,
        name: 'PPN 11%',
      }
    ];

    const { token, redirect_url } = await midtrans.createTransaction({
      orderId,
      grossAmount: finalAmount,
      planName: plan.display_name,
      user,
      itemDetails,
    });

    // Store pending transaction
    await pool.query(
      `INSERT INTO payment_transactions (user_id, plan_id, order_id, amount, status, snap_token, snap_redirect_url)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [req.user.id, plan.id, orderId, finalAmount, token, redirect_url]
    );

    res.json({
      success: true,
      data: {
        token,
        redirect_url,
        order_id: orderId,
      },
    });
  } catch (err) {
    next(err);
  }
});

const planPriority = {
  'premium': 80,
  'utbk_12m': 77, 'utbk_9m': 76, 'utbk_6m': 75, 'utbk_3m': 74, 'utbk_1m': 73,
  'premium_um': 60, 'um_to_all': 55, 'um_to_3x': 35,
  'cpns_6m': 50, 'cpns_3m': 48,
  'tka_premium_sma': 45, 'tka_premium_smp': 43, 'tka_premium_sd': 40,
  'gratis': 1
};

async function recalculateUserCurrentPlan(dbClient, userId) {
  const allActiveSubs = await dbClient.query(
    `SELECT p.name FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND (p.plan_type = 'subscription' OR p.plan_type = 'access')`,
    [userId]
  );
  let highestPlan = 'gratis';
  let highestPriority = 0;
  for (const row of allActiveSubs.rows) {
    const priority = planPriority[row.name] || 1;
    if (priority > highestPriority) {
      highestPriority = priority;
      highestPlan = row.name;
    }
  }
  await dbClient.query(`UPDATE users SET current_plan = $1 WHERE id = $2`, [highestPlan, userId]);
  return highestPlan;
}

// ─── Helper to activate user plans after successful purchase ───
async function activateUserPlans(userId, orderId, dbClient = pool) {
  let tx;
  if (typeof userId === 'object' && userId !== null && !orderId) {
    tx = userId;
    const client = dbClient || pool;
    return activateUserPlansByTx(client, tx);
  }

  const txRes = await dbClient.query(
    `SELECT * FROM payment_transactions WHERE order_id = $1`,
    [orderId]
  );
  if (txRes.rows.length === 0) return false;
  tx = txRes.rows[0];
  return activateUserPlansByTx(dbClient, tx);
}

async function activateUserPlansByTx(dbClient, tx) {
  const userId = tx.user_id;
  const orderId = tx.order_id;

  // Fetch all items for this transaction
  const itemsRes = await dbClient.query(
    `SELECT oi.*, p.name as plan_name, p.duration_days, p.plan_type, p.target_type, p.quota_limit 
     FROM order_items oi
     JOIN plans p ON p.id = oi.plan_id
     WHERE oi.transaction_id = $1`,
    [tx.id]
  );

  // Fallback for legacy transactions that stored plan_id directly on payment_transactions
  if (itemsRes.rows.length === 0 && tx.plan_id) {
    const planRes = await dbClient.query(`SELECT * FROM plans WHERE id = $1`, [tx.plan_id]);
    if (planRes.rows.length > 0) {
      const p = planRes.rows[0];
      itemsRes.rows.push({
        plan_id: tx.plan_id,
        plan_name: p.name,
        duration_days: p.duration_days,
        plan_type: p.plan_type || 'subscription',
        target_type: p.target_type || 'utbk',
        quota_limit: p.quota_limit
      });
    }
  }

  for (const item of itemsRes.rows) {
    const planType = item.plan_type;
    const quotaLimit = item.quota_limit;

    if (planType === 'subscription' || planType === 'access') {
      // Duration stacking: read expires_at BEFORE deactivating old subs
      const activeSubRes = await dbClient.query(
        `SELECT expires_at FROM subscriptions
         WHERE user_id = $1 AND plan_id = $2 AND status = 'active' AND expires_at > NOW()
         ORDER BY expires_at DESC LIMIT 1`,
        [userId, item.plan_id]
      );

      let expiresAt = new Date();
      if (activeSubRes.rows.length > 0) {
        expiresAt = new Date(activeSubRes.rows[0].expires_at);
      }
      expiresAt.setDate(expiresAt.getDate() + item.duration_days);

      // Deactivate old active subscriptions of the same plan (after reading expiry)
      await dbClient.query(
        `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1 AND plan_id = $2 AND status = 'active'`,
        [userId, item.plan_id]
      );

      // Insert new active subscription with stacked expiry
      await dbClient.query(
        `INSERT INTO subscriptions (user_id, plan_id, status, expires_at)
         VALUES ($1, $2, 'active', $3)`,
        [userId, item.plan_id, expiresAt]
      );

    } else if (planType === 'quota') {
      // Quota stacking: if an active quota subscription already exists, add quota to it
      const activeQuotaRes = await dbClient.query(
        `SELECT id FROM subscriptions 
         WHERE user_id = $1 AND plan_id = $2 AND status = 'active' AND expires_at > NOW()`,
        [userId, item.plan_id]
      );

      if (activeQuotaRes.rows.length > 0) {
        const sub = activeQuotaRes.rows[0];
        await dbClient.query(
          `UPDATE subscriptions SET quota_remaining = quota_remaining + $1 WHERE id = $2`,
          [quotaLimit, sub.id]
        );
      } else {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + item.duration_days);
        await dbClient.query(
          `INSERT INTO subscriptions (user_id, plan_id, status, expires_at, quota_remaining) 
           VALUES ($1, $2, 'active', $3, $4)`,
          [userId, item.plan_id, expiresAt, quotaLimit]
        );
      }
    }
  }

  // Determine users.current_plan from ALL active subscriptions (prevents downgrade)
  await recalculateUserCurrentPlan(dbClient, userId);

  // Update voucher usage if applied (atomic upsert to prevent race condition duplicates)
  if (tx.voucher_id) {
    const voucherInsert = await dbClient.query(
      `INSERT INTO user_vouchers (user_id, voucher_id, order_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, voucher_id) DO NOTHING`,
      [userId, tx.voucher_id, orderId]
    );
    if (voucherInsert.rowCount > 0) {
      await dbClient.query(
        `UPDATE vouchers SET usage_count = usage_count + 1 WHERE id = $1`,
        [tx.voucher_id]
      );
    }
  }

  // Process mitra affiliate referral commission if referral code is present
  try {
    await processMitraReferralSettlement(dbClient, tx);
  } catch (mitraErr) {
    console.error('Error processing mitra referral commission:', mitraErr);
  }

  return true;
}

// ─── Helper to credit commission to mitra on settled referral purchase ───
async function processMitraReferralSettlement(dbClient, tx) {
  if (!tx.referral_code && !tx.mitra_id) return;

  let mitraId = tx.mitra_id;
  if (!mitraId && tx.referral_code) {
    const mRes = await dbClient.query(
      'SELECT id FROM mitra_users WHERE referral_code = $1',
      [tx.referral_code.toUpperCase()]
    );
    if (mRes.rows.length > 0) {
      mitraId = mRes.rows[0].id;
    }
  }
  if (!mitraId) return;

  // Check if commission was already processed for this order
  const existingTx = await dbClient.query(
    'SELECT id, status FROM mitra_transactions WHERE order_id = $1',
    [tx.order_id]
  );

  // Get commission settings
  const commRes = await dbClient.query(
    "SELECT value FROM mitra_settings WHERE key = 'commission_percent'"
  );
  const commPercent = parseInt(commRes.rows[0]?.value || '10', 10);
  const commissionAmount = Math.floor((tx.amount * commPercent) / 100);

  // Get buyer details
  const buyerRes = await dbClient.query('SELECT name, email FROM users WHERE id = $1', [tx.user_id]);
  const buyer = buyerRes.rows[0] || {};

  // Get product names
  const itemsRes = await dbClient.query(
    `SELECT p.display_name FROM order_items oi JOIN plans p ON p.id = oi.plan_id WHERE oi.transaction_id = $1`,
    [tx.id]
  );
  const productName = itemsRes.rows.map(r => r.display_name).join(', ') || 'Paket Belajar Stubia';

  if (existingTx.rows.length > 0) {
    if (existingTx.rows[0].status !== 'settled') {
      await dbClient.query(
        `UPDATE mitra_transactions
         SET status = 'settled', settled_at = NOW(), commission_amount = $1, updated_at = NOW()
         WHERE order_id = $2`,
        [commissionAmount, tx.order_id]
      );
      await dbClient.query(
        `UPDATE mitra_users SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [commissionAmount, mitraId]
      );
    }
  } else {
    await dbClient.query(
      `INSERT INTO mitra_transactions (
         mitra_id, order_id, payment_transaction_id, buyer_name, buyer_email,
         product_name, total_price, commission_amount, status, settled_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'settled', NOW())`,
      [
        mitraId,
        tx.order_id,
        tx.id,
        buyer.name || 'Siswa Stubia',
        buyer.email || '',
        productName,
        tx.amount,
        commissionAmount,
      ]
    );
    await dbClient.query(
      `UPDATE mitra_users SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
      [commissionAmount, mitraId]
    );
  }
}

// ─── POST /checkout ─── Process cart checkout with optional voucher code & referral code
router.post('/checkout', verifyToken, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { planIds, voucherCode, referralCode, paymentMethod } = req.body;
    if (!planIds || !Array.isArray(planIds) || planIds.length === 0) {
      return res.status(400).json({ success: false, error: 'planIds array is required.' });
    }

    await client.query('BEGIN');

    // 1. Get plan details
    const plansRes = await client.query(
      `SELECT * FROM plans WHERE id = ANY($1) AND is_active = true`,
      [planIds]
    );

    if (plansRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Paket tidak ditemukan.' });
    }

    const totalOriginal = plansRes.rows.reduce((sum, row) => sum + row.price, 0);

    // 2. Validate voucher or referral code
    let voucher = null;
    let discount = 0;
    let validMitra = null;
    let appliedRefCode = null;

    if (voucherCode) {
      const cleanedCode = voucherCode.trim().toUpperCase();
      const voucherRes = await client.query(
        `SELECT * FROM vouchers WHERE UPPER(code) = $1 AND is_active = true`,
        [cleanedCode]
      );

      if (voucherRes.rows.length === 0) {
        // Check if it is a valid Mitra Referral Code
        const mitraRes = await client.query(
          `SELECT id, name, referral_code, status FROM mitra_users WHERE UPPER(referral_code) = $1`,
          [cleanedCode]
        );

        if (mitraRes.rows.length > 0) {
          validMitra = mitraRes.rows[0];
          if (validMitra.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'Kode referral mitra belum aktif.' });
          }
          appliedRefCode = validMitra.referral_code;

          // Get buyer discount setting
          const discountSettingRes = await client.query(
            "SELECT value FROM mitra_settings WHERE key = 'buyer_discount_percent'"
          );
          const buyerDiscountPercent = parseInt(discountSettingRes.rows[0]?.value || '10', 10);
          discount = Math.floor((totalOriginal * buyerDiscountPercent) / 100);
        } else {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: 'Kode voucher atau referral tidak valid.' });
        }
      } else {
        voucher = voucherRes.rows[0];

        if (new Date(voucher.expires_at) < new Date()) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: 'Voucher telah kedaluwarsa.' });
        }

        if (voucher.usage_limit !== null && voucher.usage_count >= voucher.usage_limit) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: 'Kuota penggunaan voucher sudah habis.' });
        }

        const userUsedRes = await client.query(
          `SELECT 1 FROM user_vouchers WHERE user_id = $1 AND voucher_id = $2`,
          [req.user.id, voucher.id]
        );
        if (userUsedRes.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: 'Anda sudah pernah menggunakan voucher ini.' });
        }

        if (totalOriginal < voucher.min_purchase) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            success: false, 
            error: `Minimum transaksi untuk voucher ini adalah Rp${voucher.min_purchase.toLocaleString('id-ID')}.` 
          });
        }

        if (voucher.discount_type === 'percentage') {
          discount = Math.floor((totalOriginal * voucher.discount_value) / 100);
          if (voucher.max_discount !== null && discount > voucher.max_discount) {
            discount = voucher.max_discount;
          }
        } else if (voucher.discount_type === 'fixed') {
          discount = voucher.discount_value;
        }

        discount = Math.min(discount, totalOriginal);
      }
    } else if (referralCode) {
      // Validate referral code if voucher is not used
      const cleanRef = referralCode.trim().toUpperCase();
      const mitraRes = await client.query(
        'SELECT id, name, referral_code, status FROM mitra_users WHERE referral_code = $1',
        [cleanRef]
      );
      if (mitraRes.rows.length > 0) {
        validMitra = mitraRes.rows[0];
        appliedRefCode = validMitra.referral_code;

        // Get buyer discount setting
        const discountSettingRes = await client.query(
          "SELECT value FROM mitra_settings WHERE key = 'buyer_discount_percent'"
        );
        const buyerDiscountPercent = parseInt(discountSettingRes.rows[0]?.value || '10', 10);
        discount = Math.floor((totalOriginal * buyerDiscountPercent) / 100);
      }
    }

    // Also check if referralCode is provided alongside voucher (track referral attribution)
    if (voucherCode && referralCode && !validMitra) {
      const cleanRef = referralCode.trim().toUpperCase();
      const mitraRes = await client.query(
        'SELECT id, name, referral_code FROM mitra_users WHERE referral_code = $1',
        [cleanRef]
      );
      if (mitraRes.rows.length > 0) {
        validMitra = mitraRes.rows[0];
        appliedRefCode = validMitra.referral_code;
      }
    }

    const subtotalAfterDiscount = Math.max(0, totalOriginal - discount);
    const taxAmount = subtotalAfterDiscount > 0 ? Math.round(subtotalAfterDiscount * 0.11) : 0;
    const finalTotal = subtotalAfterDiscount + taxAmount;

    const userRes = await client.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
    const user = userRes.rows[0];

    // ─── Case A: Free checkout ───
    if (finalTotal === 0) {
      const orderId = `STB-FREE-${Date.now()}-${uuidv4().slice(0, 8)}`;

      const txRes = await client.query(
        `INSERT INTO payment_transactions (user_id, plan_id, order_id, amount, status, payment_type, voucher_id, referral_code, mitra_id)
         VALUES ($1, NULL, $2, 0, 'settlement', 'free_voucher', $3, $4, $5) RETURNING id`,
        [req.user.id, orderId, voucher ? voucher.id : null, appliedRefCode, validMitra ? validMitra.id : null]
      );
      const transactionId = txRes.rows[0].id;

      for (const plan of plansRes.rows) {
        await client.query(
          `INSERT INTO order_items (transaction_id, plan_id, price) VALUES ($1, $2, $3)`,
          [transactionId, plan.id, plan.price]
        );
      }

      await client.query('COMMIT');

      // Process direct subscription activation
      await activateUserPlans(req.user.id, orderId, pool);

      const displayPlanNames = plansRes.rows.map(p => p.display_name).join(', ');
      const { sendPremiumPlanActivatedEmail } = require('../services/emailService');
      sendPremiumPlanActivatedEmail(user.email, user.name, displayPlanNames, 0, orderId)
        .catch(err => console.error('Free checkout activation email error:', err));

      return res.json({
        success: true,
        message: 'Aktivasi paket berhasil dilakukan.',
        data: { status: 'settlement', order_id: orderId }
      });
    }

    // ─── Case B: Paid checkout via Midtrans ───
    const orderId = `STB-${Date.now()}-${uuidv4().slice(0, 8)}`;

    const itemDetails = plansRes.rows.map(p => ({
      id: p.id,
      price: p.price,
      quantity: 1,
      name: p.display_name.slice(0, 50),
    }));

    if (discount > 0) {
      itemDetails.push({
        id: voucherCode ? `DISC-${voucherCode}` : `REF-${appliedRefCode}`,
        price: -discount,
        quantity: 1,
        name: voucherCode ? `Voucher: ${voucherCode}` : `Diskon Referral: ${appliedRefCode}`,
      });
    }

    if (taxAmount > 0) {
      itemDetails.push({
        id: 'TAX-PPN11',
        price: taxAmount,
        quantity: 1,
        name: 'PPN 11%',
      });
    }

    let enabledPayments = null;
    if (paymentMethod === 'gopay') {
      enabledPayments = ['gopay'];
    } else if (paymentMethod === 'qris' || paymentMethod === 'dana' || paymentMethod === 'seabank') {
      enabledPayments = ['other_qris', 'qris'];
    } else if (paymentMethod === 'mandiri') {
      enabledPayments = ['echannel', 'mandiri_va'];
    } else if (paymentMethod === 'bri') {
      enabledPayments = ['bri_va'];
    } else if (paymentMethod === 'bni') {
      enabledPayments = ['bni_va'];
    } else if (paymentMethod === 'permata') {
      enabledPayments = ['permata_va'];
    } else if (paymentMethod === 'cimb') {
      enabledPayments = ['cimb_clicks', 'cimb_va', 'other_va'];
    } else if (paymentMethod === 'danamon' || paymentMethod === 'bsi') {
      enabledPayments = ['other_va', 'bni_va', 'bri_va'];
    }

    let snapTx;
    try {
      snapTx = await midtrans.createTransaction({
        orderId,
        grossAmount: finalTotal,
        planName: plansRes.rows.length === 1 ? plansRes.rows[0].display_name : 'Stubia Paket Belajar',
        user,
        itemDetails,
        enabledPayments,
      });
    } catch (midtransErr) {
      console.warn('Midtrans createTransaction with enabledPayments failed, falling back to all payments:', midtransErr.message);
      snapTx = await midtrans.createTransaction({
        orderId,
        grossAmount: finalTotal,
        planName: plansRes.rows.length === 1 ? plansRes.rows[0].display_name : 'Stubia Paket Belajar',
        user,
        itemDetails,
        enabledPayments: null,
      });
    }
    const { token, redirect_url } = snapTx;

    const txRes = await client.query(
      `INSERT INTO payment_transactions (user_id, plan_id, order_id, amount, status, snap_token, snap_redirect_url, voucher_id, referral_code, mitra_id)
       VALUES ($1, NULL, $2, $3, 'pending', $4, $5, $6, $7, $8) RETURNING id`,
      [req.user.id, orderId, finalTotal, token, redirect_url, voucher ? voucher.id : null, appliedRefCode, validMitra ? validMitra.id : null]
    );
    const transactionId = txRes.rows[0].id;

    for (const plan of plansRes.rows) {
      await client.query(
        `INSERT INTO order_items (transaction_id, plan_id, price) VALUES ($1, $2, $3)`,
        [transactionId, plan.id, plan.price]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        token,
        redirect_url,
        order_id: orderId,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /webhook ─── Midtrans notification handler (no auth)
router.post('/webhook', async (req, res, next) => {
  try {
    const notification = req.body;
    const statusResponse = await midtrans.verifyNotification(notification);

    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;
    const paymentType = statusResponse.payment_type;

    let status = transactionStatus;
    if (transactionStatus === 'capture') {
      status = fraudStatus === 'accept' ? 'settlement' : 'deny';
    }

    // Atomic update: only update if not already settled (prevents double-activation)
    const updateRes = await pool.query(
      `UPDATE payment_transactions 
       SET status = $1, payment_type = $2, midtrans_transaction_id = $3, raw_response = $4, updated_at = NOW()
       WHERE order_id = $5 AND status != 'settlement'
       RETURNING id, user_id, amount, plan_id`,
      [status, paymentType, statusResponse.transaction_id, JSON.stringify(statusResponse), orderId]
    );

    // Only activate plans if this was the request that actually set 'settlement'
    if (status === 'settlement' && updateRes.rowCount > 0 && updateRes.rows.length > 0) {
      const tx = updateRes.rows[0];

      // Process plan activation
      await activateUserPlans(tx.user_id, orderId, pool);

      const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [tx.user_id]);
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        
        // Get all purchased items names
        const itemsRes = await pool.query(
          `SELECT p.display_name FROM order_items oi JOIN plans p ON p.id = oi.plan_id WHERE oi.transaction_id = $1`,
          [tx.id]
        );
        let planNames = itemsRes.rows.map(r => r.display_name).join(', ');
        if (!planNames && tx.plan_id) {
          const planRes = await pool.query('SELECT display_name FROM plans WHERE id = $1', [tx.plan_id]);
          planNames = planRes.rows[0]?.display_name || 'Premium';
        }

        const { sendPremiumPlanActivatedEmail } = require('../services/emailService');
        sendPremiumPlanActivatedEmail(user.email, user.name, planNames, tx.amount, orderId)
          .catch(err => console.error('Premium activation email webhook error:', err));
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Midtrans webhook error:', err);
    res.status(200).json({ success: true });
  }
});

// ─── GET /transactions ─── user's payment history
router.get('/transactions', verifyToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pt.*, COALESCE(p.display_name, 'Stubia Paket Belajar') AS plan_name
       FROM payment_transactions pt
       LEFT JOIN plans p ON p.id = pt.plan_id
       WHERE pt.user_id = $1
       ORDER BY pt.created_at DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST /confirm ─── Client-side payment confirmation fallback
router.post('/confirm', verifyToken, async (req, res, next) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, error: 'order_id required' });

    // Check if this transaction belongs to the user and is still pending
    const txResult = await pool.query(
      `SELECT pt.*, p.name AS plan_name, p.duration_days
       FROM payment_transactions pt
       LEFT JOIN plans p ON p.id = pt.plan_id
       WHERE pt.order_id = $1 AND pt.user_id = $2`,
      [order_id, req.user.id]
    );

    if (txResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Transaction not found' });
    const tx = txResult.rows[0];

    if (!tx.plan_name) {
      const plansRes = await pool.query(
        `SELECT p.name, p.duration_days FROM order_items oi JOIN plans p ON p.id = oi.plan_id WHERE oi.transaction_id = $1 LIMIT 1`,
        [tx.id]
      );
      if (plansRes.rows.length > 0) {
        tx.plan_name = plansRes.rows[0].name;
        tx.duration_days = plansRes.rows[0].duration_days;
      } else {
        tx.plan_name = 'Premium';
        tx.duration_days = 30;
      }
    }

    if (tx.status === 'settlement') {
      return res.json({ success: true, message: 'Already activated' });
    }

    try {
      const statusResponse = await midtrans.getTransactionStatus(order_id);
      const finalStatus = statusResponse.transaction_status === 'capture'
        ? (statusResponse.fraud_status === 'accept' ? 'settlement' : 'deny')
        : statusResponse.transaction_status;

      // Atomic update: only update if not already settled (prevents double-activation)
      const confirmUpdate = await pool.query(
        `UPDATE payment_transactions SET status = $1, updated_at = NOW() WHERE order_id = $2 AND status != 'settlement' RETURNING id`,
        [finalStatus, order_id]
      );

      if (finalStatus === 'settlement' && confirmUpdate.rowCount > 0) {
        // Activate plans (only if this request was the one that set settlement)
        await activateUserPlans(req.user.id, order_id, pool);

        const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.id]);
        if (userRes.rows.length > 0) {
          const user = userRes.rows[0];
          
          const itemsRes = await pool.query(
            `SELECT p.display_name FROM order_items oi JOIN plans p ON p.id = oi.plan_id WHERE oi.transaction_id = $1`,
            [tx.id]
          );
          let planNames = itemsRes.rows.map(r => r.display_name).join(', ');
          if (!planNames && tx.plan_id) {
            const planRes = await pool.query('SELECT display_name FROM plans WHERE id = $1', [tx.plan_id]);
            planNames = planRes.rows[0]?.display_name || 'Premium';
          }

          const { sendPremiumPlanActivatedEmail } = require('../services/emailService');
          sendPremiumPlanActivatedEmail(user.email, user.name, planNames, tx.amount, order_id)
            .catch(err => console.error('Premium activation email confirm error:', err));
        }

        return res.json({ success: true, message: 'Plan activated', plan: tx.plan_name });
      } else if (finalStatus === 'settlement' && confirmUpdate.rowCount === 0) {
        // Already settled by webhook — no double-activation
        return res.json({ success: true, message: 'Already activated' });
      }

      return res.json({ success: true, message: `Status: ${finalStatus}` });
    } catch (verifyErr) {
      console.error('Midtrans verify failed:', verifyErr.message);
      return res.status(400).json({ success: false, error: 'Verifikasi pembayaran gagal atau transaksi belum diselesaikan.' });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.activateUserPlans = activateUserPlans;
module.exports.recalculateUserCurrentPlan = recalculateUserCurrentPlan;
module.exports.planPriority = planPriority;
