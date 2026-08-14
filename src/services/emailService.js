const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM_EMAIL || "noreply@stubia.id";
const FROM_NAME = process.env.EMAIL_FROM_NAME || "Stubia";

// ─── Layout ──────────────────────────────────────────────────────────────────

function baseTemplate({
  preheader = "",
  headerLabel = "",
  headerTitle = "",
  accentColor = "#0050cb",
  body,
}) {
  return `<!DOCTYPE html>
<html lang="id" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <title>Stubia</title>
</head>
<body style="margin:0;padding:0;background-color:#eef0f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">

  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#eef0f5;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#eef0f5;">
    <tr>
      <td align="center" style="padding:48px 16px 56px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;">

          <!-- ── LOGO ── -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <img src="https://stubia.id/stubiabrandicon.png" alt="Stubia" height="32"
                style="display:inline-block;height:32px;opacity:0.9;" onerror="this.style.display='none'"/>
            </td>
          </tr>

          <!-- ── CARD ── -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06),0 8px 32px rgba(0,0,0,0.08);">

              <!-- Card header -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="background-color:#0d1117;padding:36px 48px 32px;">
                    <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:2.5px;">${headerLabel || "Stubia.id"}</p>
                    <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;letter-spacing:-0.3px;">${headerTitle}</p>
                  </td>
                </tr>
                <tr>
                  <td style="height:3px;background:linear-gradient(90deg,${accentColor},${accentColor}88);"></td>
                </tr>
              </table>

              <!-- Card body -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="padding:40px 48px 36px;">
                    ${body}
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- ── FOOTER ── -->
          <tr>
            <td style="padding-top:32px;text-align:center;">
              <p style="margin:0 0 12px;font-size:12px;color:#6b7280;line-height:1.6;">
                <span style="display:inline-block;background-color:#fee2e2;color:#991b1b;border:1px solid #fecaca;padding:2px 8px;border-radius:4px;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Email Otomatis - Jangan Dibalas</span><br/>
                Email ini dikirim secara otomatis oleh sistem Stubia.<br/>Mohon tidak membalas langsung ke email ini karena alamat email ini tidak dipantau.
              </p>
              <p style="margin:0;font-size:12px;color:#c1c7d0;">
                &copy; ${new Date().getFullYear()} Stubia.id &nbsp;&middot;&nbsp;
                <a href="https://stubia.id/privacy-policy" style="color:#c1c7d0;text-decoration:none;">Kebijakan Privasi</a>
                &nbsp;&middot;&nbsp;
                <a href="https://stubia.id/contact-us" style="color:#c1c7d0;text-decoration:none;">Hubungi Kami</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── UI components ────────────────────────────────────────────────────────────

function cta({ href, label, color = "#0050cb" }) {
  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0">
  <tr>
    <td style="border-radius:9px;background-color:${color};">
      <a href="${href}" target="_blank"
        style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;letter-spacing:0.2px;">
        ${label}
      </a>
    </td>
  </tr>
</table>`;
}

function hr() {
  return `<div style="height:1px;background-color:#f0f2f5;margin:28px 0;"></div>`;
}

function receipt(rows) {
  const inner = rows
    .map(
      ([lbl, val]) => `
<tr>
  <td style="padding:11px 0;font-size:13px;color:#6b7280;border-bottom:1px solid #f3f4f6;white-space:nowrap;padding-right:20px;">${lbl}</td>
  <td style="padding:11px 0;font-size:13px;font-weight:600;color:#111827;border-bottom:1px solid #f3f4f6;text-align:right;">${val}</td>
</tr>`,
    )
    .join("");

  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
  style="margin:20px 0;border:1px solid #f0f2f5;border-radius:10px;overflow:hidden;">
  <tr>
    <td style="padding:0 20px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${inner}
      </table>
    </td>
  </tr>
</table>`;
}

function checklist(items, dotColor = "#0050cb") {
  const rows = items
    .map(
      (item) => `
<tr>
  <td style="padding:6px 0;vertical-align:top;width:22px;">
    <div style="width:18px;height:18px;border-radius:50%;background-color:${dotColor};display:inline-block;text-align:center;line-height:18px;">
      <span style="font-size:10px;color:#ffffff;font-weight:700;">&#10003;</span>
    </div>
  </td>
  <td style="padding:6px 0;font-size:14px;color:#374151;line-height:1.6;">${item}</td>
</tr>`,
    )
    .join("");

  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:14px 0;">
  ${rows}
</table>`;
}

function steps(items) {
  const rows = items
    .map(
      (item, i) => `
<tr>
  <td style="padding:8px 0;vertical-align:top;width:28px;">
    <div style="width:22px;height:22px;border-radius:50%;background-color:#f0f2f5;display:inline-block;text-align:center;line-height:22px;">
      <span style="font-size:11px;font-weight:700;color:#6b7280;">${i + 1}</span>
    </div>
  </td>
  <td style="padding:8px 0;font-size:14px;color:#374151;line-height:1.6;">${item}</td>
</tr>`,
    )
    .join("");

  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:14px 0;">
  ${rows}
</table>`;
}

function callout({ text, bg = "#f0f5ff", border = "#0050cb" }) {
  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
  style="margin:20px 0;background-color:${bg};border-left:3px solid ${border};border-radius:0 8px 8px 0;">
  <tr>
    <td style="padding:14px 18px;font-size:13px;color:#374151;line-height:1.6;">${text}</td>
  </tr>
</table>`;
}

// ─── Core sender ─────────────────────────────────────────────────────────────

async function sendEmail({ toEmail, toName, subject, html }) {
  if (!BREVO_API_KEY) {
    console.warn("⚠️  BREVO_API_KEY tidak dikonfigurasi. Email tidak dikirim.");
    return null;
  }
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: toEmail, name: toName || toEmail }],
        subject,
        htmlContent: html,
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.message || `HTTP ${response.status}`);
    console.log(`✉️  Email terkirim ke ${toEmail} — ID: ${result.messageId}`);
    return result;
  } catch (err) {
    console.error("❌ Gagal mengirim email via Brevo:", err);
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDateID(date) {
  return date.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function guessDurationDays(planName) {
  const l = planName.toLowerCase();
  if (l.includes("mandiri") || l.includes(" um") || l === "premium_um")
    return 60;
  return 180;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. WELCOME
// ─────────────────────────────────────────────────────────────────────────────
async function sendWelcomeEmail(userEmail, userName) {
  const subject = `Selamat datang di Stubia.id, ${userName.split(" ")[0]}!`;

  const html = baseTemplate({
    preheader:
      "Akun kamu berhasil dibuat. Mulai persiapkan UTBK dan Ujian Mandiri bersama Stubia.",
    headerLabel: "Akun Aktif",
    headerTitle: "Selamat datang di Stubia.id",
    accentColor: "#0050cb",
    body: `
<p style="margin:0 0 6px;font-size:15px;color:#374151;line-height:1.8;">Halo <strong style="color:#111827;">${userName}</strong>,</p>

<p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.8;">
  Selamat datang di <strong style="color:#111827;">Stubia.id</strong> — platform persiapan UTBK dan Ujian Mandiri terpercaya!
</p>

<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.8;">
  Akun kamu berhasil dibuat dan siap digunakan. Sekarang kamu bisa mulai mengakses:
</p>

${checklist([
  "Bank soal latihan UTBK &amp; Ujian Mandiri",
  "Try out dengan sistem penilaian standar nasional",
  "Pembahasan soal lengkap dan mudah dipahami",
  "Analisis hasil belajar untuk memantau perkembanganmu",
])}

${hr()}

<p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.8;">
  Untuk mulai belajar, silakan masuk ke akunmu melalui tombol di bawah ini:
</p>

${cta({ href: "https://stubia.id/dashboard", label: "Mulai Belajar Sekarang" })}

${hr()}

<p style="margin:0 0 16px;font-size:14px;color:#6b7280;line-height:1.8;">
  Jika kamu memiliki pertanyaan atau mengalami kendala, tim kami siap membantu melalui
  <a href="https://stubia.id/contact-us" style="color:#0050cb;text-decoration:none;">halaman bantuan di stubia.id</a>.
</p>

<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.8;">
  Selamat belajar dan semoga sukses meraih kampus impianmu!
</p>

<p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">
  Salam hangat,<br/>
  <strong style="color:#111827;">Tim Stubia.id</strong>
</p>`,
  });

  return sendEmail({ toEmail: userEmail, toName: userName, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PREMIUM ACTIVATION
// ─────────────────────────────────────────────────────────────────────────────
async function sendPremiumPlanActivatedEmail(
  userEmail,
  userName,
  planName,
  price,
  orderId,
) {
  const activatedAt = new Date();
  const expiresAt = new Date(
    activatedAt.getTime() + guessDurationDays(planName) * 86400000,
  );
  const tanggalAktif = formatDateID(activatedAt);
  const tanggalBerakhir = formatDateID(expiresAt);

  const formattedPrice =
    price === 0
      ? "Gratis (voucher)"
      : new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
          minimumFractionDigits: 0,
        }).format(price);

  const isUM =
    planName.toLowerCase().includes("mandiri") ||
    planName.toLowerCase().includes(" um") ||
    planName.toLowerCase() === "premium_um";
  const accent = isUM ? "#0d9488" : "#0050cb";

  const features = isUM
    ? [
        "Seluruh bank soal Ujian Mandiri tanpa batas",
        "Try out premium Ujian Mandiri dengan analisis skor mendalam",
        "Pembahasan lengkap dengan AI Bia",
        "Konsultasi belajar dengan mentor AI Bia",
      ]
    : [
        "Seluruh bank soal UTBK tanpa batas",
        "Try out premium UTBK dengan analisis skor mendalam",
        "Pembahasan lengkap dengan AI Bia",
        "Konsultasi belajar dengan mentor AI Bia",
      ];

  const html = baseTemplate({
    preheader: `Paket ${planName} kamu sudah aktif. Akses penuh tersedia sekarang.`,
    headerLabel: "Konfirmasi Pembelian",
    headerTitle: `Paket ${planName} kamu sudah aktif`,
    accentColor: accent,
    body: `
<p style="margin:0 0 6px;font-size:15px;color:#374151;line-height:1.8;">Halo <strong style="color:#111827;">${userName}</strong>,</p>

<p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.8;">
  Terima kasih telah berinvestasi pada masa depan pendidikanmu! Pembelian paket Premium
  <strong style="color:#111827;">"${planName}"</strong> telah berhasil dikonfirmasi dan sudah aktif di akunmu.
</p>

${receipt([
  ["Paket", planName],
  ["Tanggal aktif", tanggalAktif],
  ["Berlaku hingga", tanggalBerakhir],
  ["Total pembayaran", formattedPrice],
  [
    "Nomor order",
    `<span style="font-family:'Courier New',monospace;font-size:12px;">${orderId}</span>`,
  ],
])}

<p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#111827;">Dengan paket ini, kamu sekarang memiliki akses penuh ke:</p>

${checklist(features, accent)}

${hr()}

<p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.8;">
  Yuk, mulai manfaatkan semua fitur ini sekarang:
</p>

${cta({ href: "https://stubia.id/dashboard", label: "Akses Dashboard Premium", color: accent })}

${hr()}

<p style="margin:0 0 16px;font-size:14px;color:#6b7280;line-height:1.8;">
  Jika ada pertanyaan terkait transaksi atau penggunaan fitur, jangan ragu menghubungi kami melalui
  <a href="https://stubia.id/contact-us" style="color:#0050cb;text-decoration:none;">stubia.id/contact-us</a>.
</p>

<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.8;">
  Selamat belajar dan semangat menuju kampus impian!
</p>

<p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">
  Salam sukses,<br/>
  <strong style="color:#111827;">Tim Stubia.id</strong>
</p>`,
  });

  return sendEmail({
    toEmail: userEmail,
    toName: userName,
    subject: `Pembelian paket ${planName} berhasil dikonfirmasi`,
    html,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TRYOUT APPROVED
// ─────────────────────────────────────────────────────────────────────────────
async function sendTryoutRegistrationApprovedEmail(
  userEmail,
  userName,
  packageTitle,
  packageType,
) {
  const typeLabel = packageType === "um" ? "Ujian Mandiri" : "UTBK";
  const linkPath = packageType === "um" ? "/ujian-mandiri" : "/tryout/packages";

  const html = baseTemplate({
    preheader: `Pendaftaran tryout ${packageTitle} kamu telah disetujui. Kamu siap untuk memulai.`,
    headerLabel: "Verifikasi Disetujui",
    headerTitle: "Pendaftaran tryout kamu diterima",
    accentColor: "#059669",
    body: `
<p style="margin:0 0 6px;font-size:15px;color:#374151;line-height:1.8;">Halo <strong style="color:#111827;">${userName}</strong>,</p>

<p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.8;">
  Tim admin Stubia telah meninjau dan <strong style="color:#111827;">menyetujui</strong> bukti verifikasi
  sosial media kamu. Paket tryout berikut sudah dapat kamu akses dan kerjakan sekarang.
</p>

${receipt([
  ["Paket Tryout", `<strong>${packageTitle}</strong>`],
  ["Kategori", typeLabel],
  [
    "Status",
    '<span style="color:#059669;font-weight:700;">&#10003;&nbsp; Disetujui</span>',
  ],
])}

${callout({
  text: "<strong>Perhatian:</strong> Akun gratis hanya mendapatkan <strong>satu kesempatan pengerjaan</strong> per paket tryout. Pastikan koneksi internet stabil dan kamu berada di tempat yang kondusif sebelum memulai.",
  bg: "#f0fdf4",
  border: "#059669",
})}

${cta({ href: `https://stubia.id${linkPath}`, label: "Mulai Tryout Sekarang", color: "#059669" })}

${hr()}

<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.8;">
  Selamat mengerjakan dan semangat!
</p>

<p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">
  Salam hangat,<br/>
  <strong style="color:#111827;">Tim Stubia.id</strong>
</p>`,
  });

  return sendEmail({
    toEmail: userEmail,
    toName: userName,
    subject: `Verifikasi disetujui — ${packageTitle}`,
    html,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. TRYOUT REJECTED
// ─────────────────────────────────────────────────────────────────────────────
async function sendTryoutRegistrationRejectedEmail(
  userEmail,
  userName,
  packageTitle,
  reason,
) {
  const defaultReason =
    "Bukti verifikasi tidak dapat dikonfirmasi. Pastikan akun sudah aktif mengikuti dan link komentar dapat diakses publik.";

  const html = baseTemplate({
    preheader: `Pendaftaran tryout ${packageTitle} kamu memerlukan perbaikan. Kamu dapat mendaftar ulang.`,
    headerLabel: "Perlu Perbaikan",
    headerTitle: "Verifikasi belum dapat disetujui",
    accentColor: "#dc2626",
    body: `
<p style="margin:0 0 6px;font-size:15px;color:#374151;line-height:1.8;">Halo <strong style="color:#111827;">${userName}</strong>,</p>

<p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.8;">
  Kami telah meninjau bukti verifikasi yang kamu kirimkan untuk paket <strong style="color:#111827;">${packageTitle}</strong>,
  namun belum dapat kami setujui saat ini. Kamu dapat melakukan pendaftaran ulang setelah memperbaiki hal berikut.
</p>

${receipt([
  ["Paket Tryout", `<strong>${packageTitle}</strong>`],
  [
    "Status",
    '<span style="color:#dc2626;font-weight:700;">Belum Disetujui</span>',
  ],
  ["Alasan", `<span style="color:#374151;">${reason || defaultReason}</span>`],
])}

${hr()}

<p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#111827;">Langkah perbaikan:</p>

${steps([
  "Pastikan akun kamu sudah <strong>mengikuti (follow)</strong> akun resmi Stubia di platform yang dipilih.",
  "Tinggalkan komentar sesuai ketentuan dan <strong>tag 3 teman</strong> pada postingan yang ditentukan.",
  "Salin <strong>link komentar</strong> yang valid dan dapat dibuka secara publik.",
  "Kembali ke dashboard Stubia dan kirimkan <strong>pendaftaran ulang</strong> dengan data yang telah diperbaiki.",
])}

${hr()}

<p style="margin:0 0 16px;font-size:14px;color:#6b7280;line-height:1.8;">
  Sebagai alternatif, kamu dapat upgrade ke paket Premium untuk mendapatkan akses tryout tanpa proses verifikasi.
  Gunakan kode voucher di bawah untuk mendapatkan diskon eksklusif.
</p>

${cta({ href: "https://stubia.id/dashboard", label: "Daftar Ulang", color: "#dc2626" })}

${hr()}

<p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">
  Salam hangat,<br/>
  <strong style="color:#111827;">Tim Stubia.id</strong>
</p>`,
  });

  return sendEmail({
    toEmail: userEmail,
    toName: userName,
    subject: `Verifikasi belum dapat disetujui — ${packageTitle}`,
    html,
  });
}

async function sendJobApplicationSubmittedEmail(userEmail, userName, registrationNumber, jobTitle, jobType) {
  const isFellowship = jobType?.toLowerCase() === 'fellowship';
  
  const html = baseTemplate({
    preheader: isFellowship 
      ? `Konfirmasi Pendaftaran STUBIA Academic Fellowship — ${jobTitle}`
      : `Konfirmasi Lamaran Pekerjaan — ${jobTitle}`,
    headerLabel: isFellowship ? "Academic Fellowship" : "Stubia Karir",
    headerTitle: isFellowship ? "Pendaftaran Diterima" : "Lamaran Diterima",
    body: isFellowship ? `
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Halo <strong>${userName}</strong>,
</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Terima kasih telah mendaftar dalam program <strong>STUBIA Academic Fellowship</strong> untuk peran <strong>${jobTitle}</strong>. Kami mengonfirmasi bahwa berkas pendaftaran Anda telah berhasil kami terima.
</p>

${callout({
  text: `
    <strong>Nomor Pendaftaran:</strong> <span style="font-family:monospace; font-size:14px; color:#0050cb; font-weight:bold;">${registrationNumber}</span><br/>
    <strong>Peran Fellowship:</strong> ${jobTitle}<br/>
    <strong>Status:</strong> Seleksi Berkas / Dalam Review
  `
})}

<p style="margin:24px 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Program fellowship ini dirancang khusus bagi mahasiswa terpilih untuk bertumbuh bersama praktisi EdTech dan mendesain materi belajar berkualitas. Tim kurator dan rekrutmen kami saat ini sedang meninjau kelayakan berkas (CV, foto, portofolio, dan esai motivasi) Anda.
</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Apabila profil Anda memenuhi kualifikasi awal, tim kami akan menghubungi Anda secara personal melalui WhatsApp atau Email untuk koordinasi ke tahap wawancara selanjutnya.
</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
  Selamat berjuang, semoga Anda terpilih menjadi bagian dari angkatan baru STUBIA Academic Fellow!
</p>
${hr()}
<p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">
  Salam hangat,<br/>
  <strong style="color:#111827;">Tim Rekrutmen STUBIA Academic Fellowship</strong>
</p>` : `
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Halo <strong>${userName}</strong>,
</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Terima kasih telah mendaftar untuk posisi <strong>${jobTitle}</strong> di Stubia.id. Kami mengonfirmasi bahwa berkas lamaran Anda telah berhasil kami terima.
</p>

${callout({
  text: `
    <strong>Nomor Pendaftaran:</strong> <span style="font-family:monospace; font-size:14px; color:#0050cb; font-weight:bold;">${registrationNumber}</span><br/>
    <strong>Posisi Dilamar:</strong> ${jobTitle}<br/>
    <strong>Status:</strong> Dalam Review
  `
})}

<p style="margin:24px 0 16px;font-size:15px;line-height:1.6;color:#374151;">
  Tim rekrutmen kami saat ini sedang meninjau berkas profil dan dokumen yang Anda unggah. Jika kualifikasi Anda sesuai dengan kebutuhan kami, kami akan menghubungi Anda kembali melalui WhatsApp atau Email untuk tahap wawancara selanjutnya.
</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
  Semoga sukses dalam proses seleksi ini!
</p>
${hr()}
<p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">
  Salam hangat,<br/>
  <strong style="color:#111827;">Tim Rekrutmen Stubia.id</strong>
</p>`,
  });

  return sendEmail({
    toEmail: userEmail,
    toName: userName,
    subject: isFellowship 
      ? `Terima Kasih Telah Mendaftar STUBIA Academic Fellowship — ${registrationNumber}`
      : `Lamaran Diterima — No. Pendaftaran ${registrationNumber} (${jobTitle})`,
    html,
  });
}

module.exports = {
  sendWelcomeEmail,
  sendPremiumPlanActivatedEmail,
  sendTryoutRegistrationApprovedEmail,
  sendTryoutRegistrationRejectedEmail,
  sendJobApplicationSubmittedEmail,
};
