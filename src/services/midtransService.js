const midtransClient = require('midtrans-client');

const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY || '',
  clientKey: process.env.MIDTRANS_CLIENT_KEY || '',
});

/**
 * Create a Snap transaction token
 * @param {Object} params
 * @param {string} params.orderId - Unique order ID
 * @param {number} params.grossAmount - Total amount in IDR
 * @param {string} params.planName - Plan display name
 * @param {Object} params.user - { id, name, email }
 * @returns {Promise<{ token: string, redirect_url: string }>}
 */
async function createTransaction({ orderId, grossAmount, planName, user, itemDetails, enabledPayments }) {
  const parameter = {
    transaction_details: {
      order_id: orderId,
      gross_amount: grossAmount,
    },
    item_details: itemDetails || [
      {
        id: orderId,
        price: grossAmount,
        quantity: 1,
        name: `Stubia ${planName} Plan`,
      },
    ],
    customer_details: {
      first_name: user.name,
      email: user.email,
    },
    callbacks: {
      finish: `${process.env.CLIENT_URL || 'http://localhost:5173'}/pricing?payment=success`,
      error: `${process.env.CLIENT_URL || 'http://localhost:5173'}/pricing?payment=error`,
      pending: `${process.env.CLIENT_URL || 'http://localhost:5173'}/pricing?payment=pending`,
    },
  };

  if (enabledPayments && Array.isArray(enabledPayments) && enabledPayments.length > 0) {
    parameter.enabled_payments = enabledPayments;
  }

  const transaction = await snap.createTransaction(parameter);
  return {
    token: transaction.token,
    redirect_url: transaction.redirect_url,
  };
}

/**
 * Verify webhook notification signature
 * @param {Object} notification - Midtrans notification body
 * @returns {Promise<Object>} - Verified notification status
 */
async function verifyNotification(notification) {
  const statusResponse = await snap.transaction.notification(notification);
  return statusResponse;
}

/**
 * Get Midtrans client key for frontend
 */
function getClientKey() {
  return process.env.MIDTRANS_CLIENT_KEY || '';
}

module.exports = {
  createTransaction,
  verifyNotification,
  getClientKey,
};
