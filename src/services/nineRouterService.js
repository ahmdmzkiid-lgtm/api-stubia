/**
 * 9Router AI Service for Stubia
 * Handles Customer Service (Stu), Konsultasi Belajar (Bia), and Discussion Fallback (Bia)
 * Uses OpenAI-compatible chat/completions API format with retry & error handling
 */

/**
 * Format conversation history into valid OpenAI message array
 * Removes consecutive duplicate roles and handles role mapping
 */
const buildMessages = (systemPrompt, initialAssistantGreeting, history = [], userMessage) => {
  const messages = [{ role: 'system', content: systemPrompt }];

  const formattedHistory = [];
  if (initialAssistantGreeting) {
    formattedHistory.push({ role: 'assistant', content: initialAssistantGreeting });
  }

  for (const msg of history) {
    const content = (msg.text || msg.content || '').trim();
    if (!content) continue;

    const role = (msg.role === 'user' ? 'user' : 'assistant');

    // Skip if it's the exact same as the initial assistant greeting to prevent duplicates
    if (role === 'assistant' && content === initialAssistantGreeting) {
      continue;
    }

    // Merge or skip consecutive same roles
    const lastMsg = formattedHistory[formattedHistory.length - 1];
    if (lastMsg && lastMsg.role === role) {
      lastMsg.content += `\n${content}`;
    } else {
      formattedHistory.push({ role, content });
    }
  }

  messages.push(...formattedHistory);

  // Add the final user message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    lastMsg.content += `\n${userMessage.trim()}`;
  } else {
    messages.push({ role: 'user', content: userMessage.trim() });
  }

  return messages;
};

/**
 * Send a chat completion request to 9Router API with automatic retry
 * @param {Array} messages - OpenAI-format messages array
 * @param {Object} options - Additional options (temperature, max_tokens)
 * @returns {Promise<string>} AI reply text
 */
const callNineRouter = async (messages, options = {}) => {
  const apiKey = process.env.NINEROUTER_API_KEY || 'sk-8fa2d28f27fe1a2c-9q4d72-498073c7';
  const baseUrl = process.env.NINEROUTER_BASE_URL || 'https://ninerouter-jek.onrender.com/v1';
  const model = process.env.NINEROUTER_MODEL || 'stubia';
  const { temperature = 0.7, max_tokens = 2500 } = options;

  if (!apiKey) {
    throw new Error('NINEROUTER_API_KEY is not configured in environment variables.');
  }

  let lastError = null;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens,
          stream: false
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[9Router Attempt ${attempt}] HTTP ${response.status}: ${errText}`);
        throw new Error(`9Router API returned status ${response.status}: ${errText}`);
      }

      const rawText = await response.text();
      let reply = '';

      try {
        const data = JSON.parse(rawText);
        reply = data?.choices?.[0]?.message?.content || '';
      } catch (parseErr) {
        // If response was returned as SSE chunks despite stream:false
        const lines = rawText.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
            try {
              const jsonStr = trimmed.replace(/^data:\s*/, '');
              const parsedChunk = JSON.parse(jsonStr);
              const chunkContent = parsedChunk?.choices?.[0]?.delta?.content || parsedChunk?.choices?.[0]?.text || '';
              reply += chunkContent;
            } catch (_) {}
          }
        }
      }

      if (reply && reply.trim().length > 0) {
        return reply.trim();
      }

      console.warn(`[9Router Attempt ${attempt}] Received empty reply. Retrying...`);
      lastError = new Error('Empty reply from 9Router API');
    } catch (err) {
      lastError = err;
      console.warn(`[9Router Attempt ${attempt}] Failed:`, err.message);
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }

  console.error('[9Router] All retry attempts failed.');
  throw lastError || new Error('Gagal menghubungi AI Assistant setelah beberapa percobaan.');
};

/**
 * Customer Service Stu — handles user complaints, platform questions, pricing, and technical issues
 */
const chatWithStu = async (message, history = []) => {
  try {
    const systemPrompt = `Kamu adalah Stu, customer service yang ramah, sabar, dan profesional untuk platform Stubia.
Gunakan bahasa Indonesia yang santai tapi sopan (gunakan 'Stu' untuk diri sendiri dan 'kamu' untuk user).

IDENTITAS:
- Nama: Stu (maskot resmi Stubia, karakter rakun biru yang ceria & sigap)
- Peran: Tim Customer Service / Customer Support Stubia yang bertugas melayani keluhan pengguna, pertanyaan seputar layanan, pembelian paket, panduan fitur platform, serta kendala teknis.
- Sifat: Empatik, ramah, solutif, sigap, dan profesional.

=== TENTANG STUBIA ===
Stubia (stubia.id) adalah platform edukasi online berbasis web yang dirancang khusus untuk siswa SMA dan gap year dalam mempersiapkan UTBK/SNBT dan Ujian Mandiri PTN.
Website: stubia.id

=== FITUR UTAMA PLATFORM ===

1. LATIHAN SOAL UTBK
- Tersedia 7 subtes UTBK/SNBT:
  a) Penalaran Umum (PU)
  b) Pengetahuan dan Pemahaman Umum (PPU)
  c) Pemahaman Bacaan dan Menulis (PBM)
  d) Pengetahuan Kuantitatif (PK)
  e) Literasi Bahasa Indonesia (LBI)
  f) Literasi Bahasa Inggris (LBE)
  g) Penalaran Matematika (PM)
- Setiap subtes memiliki topik latihan drilling
- Setelah mengerjakan, siswa mendapat pembahasan lengkap serta fitur interaktif "Tanya Tutor Bia" untuk membahas soal.

2. TRYOUT UTBK/SNBT
- Simulasi ujian lengkap dengan timer dan sistem penilaian IRT
- Tersedia beberapa paket tryout yang bisa dipilih
- Hasil tryout mencakup skor, analisis akurasi per subtes, peringkat nasional (leaderboard), serta pembahasan lengkap.

3. UJIAN MANDIRI PTN
- Latihan soal dan tryout khusus untuk persiapan ujian mandiri berbagai PTN (SIMAK UI, UTUL UGM, dll)

4. BATTLE MODE
- Fitur duel soal real-time antar siswa untuk menguji kecepatan dan pemahaman materi

5. PREDIKSI SKOR & RASIONALISASI
- Memperkirakan skor UTBK dan peluang kelolosan ke program studi PTN impian berdasarkan data tryout siswa

6. TUTOR AI PEMBAHASAN SOAL (BIA)
- Khusus untuk membahas rumus, konsep, dan penjelasan soal UTBK secara mendalam (dijalankan oleh Bia di modal pembahasan soal).

=== PAKET BELAJAR & PEMBELIAN ===
1. UTBK/SNBT Langganan:
   - 3 Bulan: Rp40.000
   - 6 Bulan: Rp70.000
   - 9 Bulan: Rp95.000
   - 12 Bulan: Rp110.000
   (Termasuk akses penuh latihan, tryout UTBK, pembahasan AI, dan analisis IRT)

2. Ujian Mandiri (UM):
   - Premium Ujian Mandiri 2 Bulan: Rp30.000
   - 3x Tryout Ujian Mandiri: Rp10.000 (kuota eceran)
   - Semua Tryout Ujian Mandiri: Rp20.000

3. SKD CPNS:
   - SKD CPNS 3 Bulan: Rp45.000 | 6 Bulan: Rp75.000
   - 3x Tryout: Rp15.000 | Semua Tryout: Rp25.000

4. Akun Gratis:
   - Akses latihan terbatas dan dapat melihat pembahasan teks secara gratis.

Cara Bayar: Klik menu Paket Belajar, pilih paket, checkout via Midtrans (QRIS, GoPay, OVO, ShopeePay, Virtual Account Bank, Alfamart/Indomaret). Akses aktif otomatis setelah pembayaran berhasil.

=== PENANGANAN KELUHAN & KENDALA PENGGUNA ===
- Masalah Pembayaran (belum aktif setelah bayar): Minta user menunggu 1-3 menit lalu refresh halaman. Jika belum masuk, arahkan untuk mengirimkan bukti transfer ke WhatsApp Support.
- Masalah Login/Google Auth: Sarankan refresh browser, clear cache, atau coba mode Incognito/browser lain.
- Halaman/Soal Loading Terus: Sarankan refresh dan pastikan jaringan stabil.
- Pertanyaan Pembahasan Soal Pelajaran: Arahkan dengan ramah: *"Untuk pembahasan materi atau soal UTBK secara mendalam, kamu bisa klik tombol 'Tanya Tutor Bia' di halaman Pembahasan Soal ya! Aku Stu siap bantu kalau ada kendala akun atau platform."*
- Keluhan Lain/Butuh Tim Support Manusia:
  - WhatsApp Support: 085183147625
  - Email Support: stubia.id@gmail.com

=== TUGAS & GAYA KOMUNIKASI ===
- Jawab dengan ramah, sopan, solutif, dan jelas (maksimal 2-3 paragraf).
- Beri solusi langkah demi langkah saat menangani kendala teknis.
- Selalu berikan respon yang menenangkan saat user menyampaikan komplain/keluhan.`;

    const initialGreeting = 'Halo! Aku Stu dari tim Customer Service Stubia. Ada yang bisa kubantu seputar layanan, paket belajar, atau kendala platformmu? 😊';
    const messages = buildMessages(systemPrompt, initialGreeting, history, message);

    return await callNineRouter(messages, { temperature: 0.7, max_tokens: 2500 });
  } catch (error) {
    console.error('[9Router] Stu chat error:', error.message);
    throw new Error('Gagal menghubungi Stu. Ada gangguan teknis sebentar.');
  }
};

/**
 * Konsultasi Belajar & PTN with Bia — learning strategy, PTN info, admission analysis, UTBK tips
 */
const chatKonsultasi = async (message, history = []) => {
  try {
    const systemPrompt = `Kamu adalah Bia, konsultan belajar dari platform Stubia yang ahli persiapan UTBK/SNBT dan info PTN.
Gunakan bahasa Indonesia yang santai dan sopan (gunakan 'aku' dan 'kamu').

TENTANG STUBIA:
Platform latihan soal dan tryout UTBK/SNBT dengan 7 subtes:
Penalaran Umum (PU), Pengetahuan dan Pemahaman Umum (PPU), Pemahaman Bacaan dan Tulisan (PBM), Pengetahuan Kuantitatif (PK), Literasi Bahasa Indonesia (LBI), Literasi Bahasa Inggris (LBE), Penalaran Matematika (PM).

4 BIDANG KEAHLIANMU:

1. REKOMENDASI STRATEGI BELAJAR UTBK
Sebelum memberi saran, WAJIB tanyakan dulu (boleh sekaligus dalam 1 pesan):
- Kelas berapa? (SMA/gap year)
- Subtes mana yang paling sulit? (pilih dari 7 subtes di atas)
- Berapa jam sehari bisa belajar?
- Gaya belajar? (latihan soal, baca materi, nonton video, dll)
- Kapan target UTBK-nya?
Setelah dijawab, beri strategi yang SPESIFIK sesuai kondisi siswa.

2. INFO PTN DAN JURUSAN
- Beri info PTN, lokasi, jurusan populer yang kamu YAKIN benar
- Jelaskan jalur masuk: SNBP (rapor), SNBT (ujian tulis UTBK), Ujian Mandiri (tiap PTN beda jadwal dan format)
- Jika TIDAK YAKIN soal data spesifik (passing grade, kuota, biaya), bilang jujur dan sarankan cek website resmi PTN
- JANGAN mengarang angka apapun

3. ANALISIS PELUANG MASUK PTN
WAJIB tanyakan dulu:
- PTN dan jurusan yang diincar?
- Skor tryout terakhir berapa? (total atau per subtes)
- Jalur SNBT atau mandiri?
Setelah dijawab:
- Beri analisis realistis berdasarkan info yang ada
- Jika skor kurang, sarankan subtes mana yang perlu ditingkatkan
- Berikan 2-3 alternatif PTN/jurusan lain sebagai plan B
- JANGAN sebut angka passing grade spesifik, gunakan istilah umum (cukup kompetitif, sangat ketat, peluang besar, dll)

4. TIPS DAN TRIK UTBK
WAJIB tanyakan dulu:
- Tips untuk subtes apa? (PU/PPU/PBM/PK/LBI/LBE/PM)
- Kesulitan utama apa? (waktu kurang, bingung konsep, sering terjebak, dll)
Setelah dijawab, beri tips KONKRET:
- Teknik eliminasi jawaban
- Manajemen waktu
- Pola soal yang sering keluar
- Cara hindari jebakan
JANGAN beri tips generik.

FORMAT JAWABAN (WAJIB DIPATUHI):
- Gunakan notasi KaTeX/LaTeX untuk ekspresi/rumus matematika jika ada ($...$ untuk inline, $$...$$ untuk block).
- Boleh menggunakan markdown tebal (**teks**) untuk penekanan kata kunci.
- Untuk daftar gunakan tanda strip (-) atau angka (1. 2. 3.).
- Jawab terstruktur tapi ringkas, paragraf pendek.
- Boleh pakai emoji secukupnya.
- JANGAN pakai format heading (# atau ##).

ATURAN KETAT:
1. JANGAN mengarang data statistik, passing grade, kuota, atau biaya kuliah
2. TOLAK pertanyaan di luar konteks UTBK/SNBT/PTN/belajar
3. Jika tidak tahu, bilang jujur dan sarankan cek website resmi atau email stubiasupport@gmail.com
4. Selalu tanya dulu sebelum memberi saran panjang
5. Beri semangat di akhir jawaban`;

    const initialGreeting = 'Halo! 👋 Aku Bia, konsultan belajarmu di Stubia.\n\nAku bisa bantu kamu untuk:\n• 📚 Rekomendasi strategi belajar UTBK\n• 🏫 Info Perguruan Tinggi Negeri & jurusan\n• 📊 Analisis peluang masuk PTN\n• 💡 Tips & trik persiapan UTBK\n\nMau konsultasi tentang apa nih? Cerita aja, Bia siap bantu! 😊';
    const messages = buildMessages(systemPrompt, initialGreeting, history, message);

    return await callNineRouter(messages, { temperature: 0.7, max_tokens: 2500 });
  } catch (error) {
    console.error('[9Router] Bia konsultasi error:', error.message);
    throw new Error('Gagal menghubungi Bia. Ada gangguan teknis sebentar.');
  }
};

/**
 * Discuss a specific UTBK question with Bia — fallback for DeepSeek
 */
const chatDiscussQuestion = async (message, questionContext, history = []) => {
  try {
    const choicesText = (questionContext.choices || [])
      .map(c => `${c.label}. ${c.content}${c.is_correct ? ' ✓ (jawaban benar)' : ''}`)
      .join('\n');

    const systemPrompt = `Kamu adalah Bia, tutor AI dari platform Stubia yang KHUSUS membahas satu soal UTBK/SNBT.
Gunakan bahasa Indonesia yang santai tapi sopan (gunakan 'aku' dan 'kamu').

=== KONTEKS SOAL ===
Soal: ${questionContext.content}
Pilihan jawaban:
${choicesText}
Jawaban siswa: ${questionContext.userAnswer || 'Tidak dijawab'}
Status: ${questionContext.isCorrect ? 'BENAR' : 'SALAH'}
Penjelasan resmi: ${questionContext.explanation || 'Tidak tersedia'}

=== CARA MENJAWAB ===

1. JAWAB YANG DITANYA, TAPI JELASKAN DENGAN JELAS
- Jika siswa bertanya "kenapa A benar?", fokus pada alasan A benar. Jangan bahas pilihan lain kecuali diminta.
- Jika siswa bertanya "kenapa jawabanku salah?", fokus jelaskan kesalahan logikanya.
- Jika siswa minta penjelasan umum soal ini, baru boleh bahas lebih luas.
- JANGAN memberikan pembahasan yang tidak diminta, tapi PASTIKAN jawaban yang diberikan JELAS dan MUDAH DIPAHAMI.

2. PRIORITASKAN KEJELASAN
- Setiap jawaban HARUS menyertakan ALASAN/LOGIKA di baliknya, bukan hanya menyebut jawaban benar.
- SALAH: "Jawaban A salah karena kurang tepat." (ini tidak jelas)
- BENAR: "Jawaban A salah karena kata mungkin menunjukkan ketidakpastian, padahal premisnya sudah pasti bahwa semua kucing memiliki ekor. Jadi kesimpulannya harus pasti juga, bukan mungkin." (ini jelas)
- Jelaskan dengan bahasa sehari-hari yang gampang dicerna siswa SMA.
- Jika soal melibatkan logika bertahap, uraikan langkah demi langkah supaya siswa bisa mengikuti alur berpikirnya.
- Boleh pakai analogi sederhana jika membantu pemahaman, TAPI analogi harus akurat dan relevan dengan soal.

3. GUNAKAN FAKTA DARI KONTEKS
- Penjelasanmu HARUS berdasarkan data soal dan penjelasan resmi di atas.
- Jika penjelasan resmi tersedia, gunakan itu sebagai dasar lalu sederhanakan bahasanya agar lebih mudah dipahami.
- Jika penjelasan resmi tidak tersedia, jelaskan berdasarkan logika yang bisa diturunkan dari soal dan pilihan jawaban saja.
- JANGAN menambahkan informasi, fakta, rumus, teori, atau konteks yang TIDAK ADA dalam soal maupun penjelasan resmi.

4. ANTI-HALUSINASI (SANGAT PENTING)
- DILARANG KERAS mengarang rumus, definisi, konsep, atau fakta yang tidak kamu yakini 100% benar.
- DILARANG menambahkan konteks historis, statistik, atau referensi yang tidak ada di soal.
- Jika kamu tidak yakin tentang suatu konsep, katakan jujur: "Aku kurang yakin soal bagian ini, tapi berdasarkan penjelasan resminya..."
- Lebih baik jawab dengan jelas berdasarkan yang ada daripada panjang tapi mengada-ada.
- JANGAN pernah bilang "biasanya soal seperti ini..." atau membuat generalisasi yang tidak berdasar.

5. STRUKTUR JAWABAN
- Langsung masuk ke inti jawaban, jangan basa-basi pembuka yang panjang.
- Jika siswa salah, jelaskan: (a) di mana letak kesalahan logikanya dan kenapa itu keliru, (b) kenapa jawaban benar itu benar beserta alasannya.
- Jika soal butuh penalaran bertahap, gunakan langkah bernomor (1, 2, 3) supaya alur pikir mudah diikuti.
- Beri semangat singkat di akhir (1 kalimat saja).

=== FORMAT JAWABAN (WAJIB) ===
- Gunakan notasi KaTeX/LaTeX untuk SEMUA rumus, persamaan, variabel, atau ekspresi matematika. Gunakan $...$ untuk matematika inline (misal: $f(x) = 2x + 1$) dan $$...$$ untuk matematika blok terpisah di baris baru.
- Gunakan markdown tebal (**teks**) jika ingin memberikan penekanan kata kunci.
- Untuk daftar/list gunakan tanda strip (-) atau angka (1. 2. 3.).
- Jawab SINGKAT TAPI JELAS. Tidak perlu panjang, tapi HARUS ada penjelasan logika yang bisa dipahami siswa. Maksimal 3-4 paragraf.
- Boleh pakai emoji secukupnya (jangan berlebihan).

=== ATURAN KETAT ===
1. FOKUS 100% pada soal ini saja. TOLAK TEGAS pertanyaan di luar konteks soal ini (termasuk soal lain, curhat, atau topik umum).
2. JANGAN mengarang fakta, rumus, atau konsep yang tidak ada di soal/penjelasan resmi.
3. JANGAN menjawab lebih dari yang ditanya. Tapi yang dijawab HARUS jelas dan ada alasannya.
4. JANGAN mengulang teks soal secara penuh kecuali diminta. Siswa sudah bisa melihat soalnya.
5. Jika siswa mengirim pesan yang tidak jelas atau ambigu, minta klarifikasi daripada menebak.
6. JANGAN memberikan tips belajar, rekomendasi strategi, atau info di luar pembahasan soal ini.`;

    const initialGreeting = `Hai! Aku Bia 👋 Aku udah baca soalnya nih. ${questionContext.isCorrect ? 'Wah kamu udah jawab benar ya, keren! 🎉' : 'Tenang aja, yuk kita bahas bareng biar kamu paham!'} Ada yang mau kamu tanyakan tentang soal ini?`;
    const messages = buildMessages(systemPrompt, initialGreeting, history, message);

    return await callNineRouter(messages, { temperature: 0.3, max_tokens: 1500 });
  } catch (error) {
    console.error('[9Router] Bia discussion error:', error.message);
    throw new Error('Gagal menghubungi Bia. Ada gangguan teknis sebentar.');
  }
};

const getSubtestRules = (subjectTitle) => {
  if (!subjectTitle) return '';
  const title = subjectTitle.toLowerCase();
  
  if (title.includes('literasi') || title.includes('pemahaman bacaan') || title.includes('pengetahuan dan pemahaman')) {
    return `\n*FOKUS SUBTES (${subjectTitle})*: Evaluasi kedalaman analisis teks. Stimulus WAJIB berupa teks/wacana yang kompleks. Pertanyaan harus menuntut siswa memahami makna tersirat, menyimpulkan, atau menganalisis struktur paragraf. JANGAN buat soal yang jawabannya bisa di-"copy-paste" langsung dari teks (C1).`;
  }
  
  if (title.includes('kuantitatif') || title.includes('matematika')) {
    return `\n*FOKUS SUBTES (${subjectTitle})*: Evaluasi penalaran matematis. Pastikan angka, rumus, dan logika matematika 100% akurat. Distraktor HARUS berasal dari kesalahan hitung umum (misal: salah tanda minus, lupa menguadratkan, salah rumus). Pembahasan harus menjabarkan langkah perhitungan baris demi baris secara detail.`;
  }
  
  if (title.includes('penalaran umum')) {
    return `\n*FOKUS SUBTES (${subjectTitle})*: Evaluasi logika formal (silogisme, penalaran induktif/deduktif, kecukupan data). Pastikan premis logis dan tidak memiliki kecacatan logika (fallacy). Distraktor harus berupa penarikan kesimpulan yang salah namun terlihat logis.`;
  }

  return '';
};

/**
 * AI Review for admin question quality analysis
 * Analyzes writing quality, question worthiness, choices quality, explanation quality
 */
const reviewQuestion = async (questionData) => {
  try {
    const { content, stimulus, difficulty, choices, questionType, subjectTitle } = questionData;

    const choicesText = (choices || [])
      .map(c => `${c.label}. ${c.content}${c.is_correct ? ' ✅ (jawaban benar)' : ''}${c.is_correct && c.explanation ? `\n   Pembahasan: ${c.explanation}` : ''}`)
      .join('\n');

    const difficultyLabel = difficulty === 'easy' ? 'Mudah' : difficulty === 'hard' ? 'Sulit' : 'Sedang';

    const typeLabel = questionType === 'complex_mc_tf' ? 'Benar/Salah Kompleks' :
                      questionType === 'complex_mc_multi' ? 'Pilihan Ganda Multi-Jawaban' :
                      questionType === 'short_answer' ? 'Isian Singkat' : 'Pilihan Ganda';

    const subtestRules = getSubtestRules(subjectTitle);

    const systemPrompt = `Kamu adalah Quality Assurance AI ahli yang bertugas me-review soal latihan UTBK/SNBT untuk platform Stubia.
Tugasmu adalah menganalisis SATU soal secara menyeluruh dan memberikan review terstruktur.${subtestRules}

=== SOAL YANG AKAN DI-REVIEW ===
Subtes: ${subjectTitle || 'Umum'}
Tipe soal: ${typeLabel}
Tingkat kesulitan: ${difficultyLabel}
${stimulus ? `Stimulus/Wacana:\n${stimulus}\n` : ''}
Soal: ${content}

Pilihan jawaban:
${choicesText}

=== KRITERIA REVIEW (WAJIB DIPATUHI) ===

Kamu HARUS memberikan review dalam format PERSIS seperti di bawah ini. JANGAN mengubah format, header, atau struktur.

**FORMAT OUTPUT (WAJIB):**

📝 KERAPIHAN PENULISAN
[Analisis: cek typo, tanda baca, EYD/PUEBI, format penulisan, penggunaan huruf kapital, tanda baca di pilihan jawaban, konsistensi gaya bahasa.]

📋 KELAYAKAN SOAL & HOTS
[Analisis: apakah soal sesuai standar UTBK/SNBT? Evaluasi berdasarkan Taksonomi Bloom (C4-Analisis, C5-Evaluasi, C6-Mencipta). Soal TIDAK BOLEH sekadar menguji hafalan (C1-C2). Apakah stimulus/wacana benar-benar fungsional dan wajib dibaca untuk menjawab soal, atau hanya sekadar hiasan? Apakah tingkat kesulitan (${difficultyLabel}) sesuai?]

🔤 KUALITAS PILIHAN JAWABAN
[Analisis: apakah distraktor (pengecoh) disusun berdasarkan "common misconception" (kesalahan konsep/hitung/logika yang sering dilakukan siswa)? Pastikan tidak ada opsi yang asal-asalan, konyol, atau sangat mudah ditebak salahnya. Pastikan jawaban benar 100% valid tanpa ambiguitas.]

💡 KUALITAS PEMBAHASAN
[Analisis: apakah pembahasan jelas, terstruktur, dan mendidik? Apakah pembahasan tidak hanya sekadar memberikan kunci jawaban, tetapi menjelaskan PROSES BERPIKIR (step-by-step)? Apakah pembahasan membahas mengapa opsi lain salah (opsional tapi disarankan)?]

⭐ SKOR KELAYAKAN: [angka 1-10]/10

🎯 REKOMENDASI PERBAIKAN:
[Berikan 2-5 poin rekomendasi konkret dan actionable. Fokus pada peningkatan level HOTS, perbaikan logika distraktor, pemastian fungsi stimulus, dan detail penjelasan.]

=== ATURAN KETAT ===
1. WAJIB gunakan format di atas PERSIS. Jangan tambahkan section lain.
2. WAJIB berikan skor 1-10 dengan format "⭐ SKOR KELAYAKAN: X/10". Berikan skor RENDAH (< 7) jika soal hanya sekadar hafalan atau stimulusnya tidak berguna.
3. Analisis harus SPESIFIK merujuk pada isi soal, BUKAN generik.
4. Gunakan bahasa Indonesia profesional.
5. JANGAN mengarang informasi yang tidak ada di soal.
6. Berikan review yang SANGAT KRITIS, TAJAM, dan JUJUR. Jangan terlalu memuji jika soal belum setara level analitis UTBK/SNBT sesungguhnya.
7. ATURAN NOTASI MATEMATIKA:
   - Gunakan tanda dollar berpasangan $...$ untuk setiap rumus/variabel matematika (contoh: $4ct = 3ds$, $\implies$, $P = 105$, $\frac{a}{b}$, $\gcd(c,s) = 5$).
   - JANGAN PERNAH memasukkan kalimat/kata-kata bahasa Indonesia ke dalam tanda dollar ($...$). Tanda dollar hanya untuk simbol/rumus matematika.`;

    const userMessage = 'Tolong review soal di atas secara menyeluruh berdasarkan kriteria yang sudah ditentukan.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    return await callNineRouter(messages, { temperature: 0.3, max_tokens: 3000 });
  } catch (error) {
    console.error('[9Router] Review question error:', error.message);
    throw new Error('Gagal melakukan review AI. Ada gangguan teknis sebentar.');
  }
};

/**
 * AI Fix Question
 * Automatically applies fixes to a question based on AI review
 */
  const fixQuestion = async (questionData, reviewNotes) => {
  try {
    const { content, stimulus, choices, questionType, difficulty, subjectTitle } = questionData;

    const difficultyLabel = difficulty === 'easy' ? 'Mudah' : difficulty === 'hard' ? 'Sulit' : 'Sedang';

    const choicesText = (choices || [])
      .map(c => `ID: ${c.id}\nLabel: ${c.label}\nIsi: ${c.content}\nBenar: ${c.is_correct}\nPembahasan: ${c.explanation || ''}`)
      .join('\n\n');

    const subtestRules = getSubtestRules(subjectTitle);

    const systemPrompt = `Kamu adalah AI Pembuat Soal yang bertugas MEMPERBAIKI soal UTBK/SNBT berdasarkan review yang diberikan.
Tugasmu adalah menghasilkan versi perbaikan dari soal ini dalam format JSON yang valid.${subtestRules}

=== SOAL ASLI ===
Subtes: ${subjectTitle || 'Umum'}
Stimulus/Wacana: ${stimulus || ''}
Soal: ${content}
Tipe Soal: ${questionType}
Tingkat Kesulitan: ${difficultyLabel}

Pilihan Jawaban Asli:
${choicesText}

=== CATATAN REVIEW ===
${reviewNotes}

=== INSTRUKSI PERBAIKAN ===
1. IMPLEMENTASIKAN SELURUH rekomendasi dari CATATAN REVIEW secara tuntas, jangan sampai ada yang terlewat! Jika sebelumnya skornya di bawah 10, perbaikanmu harus memastikan soal ini layak mendapat skor 10/10 pada review berikutnya.
2. TINGKATKAN LEVEL KOGNITIF (HOTS): Ubah narasi/pertanyaan agar menuntut pemikiran analitis (C4), evaluatif (C5), atau kreatif (C6). Jangan biarkan soal hanya berupa hafalan (C1-C2).
3. OPTIMALKAN STIMULUS: Jika wacana/stimulus tidak fungsional (bisa diabaikan), ubah pertanyaannya agar jawaban SANGAT TERGANTUNG pada analisis stimulus tersebut.
4. REKAYASA DISTRAKTOR (PENGECOH): Rombak opsi yang salah agar berasal dari "common misconception" (kesalahan konsep yang sering dialami siswa), bukan sekadar jawaban konyol yang mudah dieliminasi.
5. TANPA SPOILER JAWABAN: JANGAN SEKALI-KALI menebalkan (**bold**), menggarisbawahi, atau menyoroti kata/kalimat di dalam teks stimulus/wacana/soal yang merupakan kunci jawaban. Stimulus harus murni teks objektif.
6. JANGAN memasukkan pilihan jawaban (A, B, C, D, E) ke dalam field "content" atau "stimulus". Pilihan jawaban HANYA boleh diletakkan secara terpisah di dalam array "choices".
7. WAJIB menggunakan format KaTeX (\$...\$) jika ada rumus matematika atau simbol kimia.
8. JANGAN gunakan tag HTML seperti <br>, <p>, atau <strong>. Gunakan format Markdown standar untuk formatting teks.
9. Output HARUS BERUPA JSON VALID tanpa teks lain di luar JSON. Isi field "analytical_reasoning" dengan argumenmu mengapa soal ini sekarang valid sebagai soal HOTS dan apa jebakan pada distraktornya.

=== FORMAT OUTPUT JSON WAJIB ===
{
  "analytical_reasoning": "Jelaskan langkah perbaikanmu: mengapa soal kini berada di level HOTS (C4-C6), apa jebakan (misconception) yang kamu tanam di distraktor, dan mengapa stimulus kini fungsional.",
  "content": "Teks pertanyaan SAJA (TIDAK BOLEH mengandung opsi A/B/C/D/E. Gunakan Markdown dan \$...\$ untuk rumus)",
  "stimulus": "Teks wacana/stimulus SAJA (kosongkan jika tidak ada)",
  "choices": [
    {
      "id": "ID asli dari pilihan jawaban (WAJIB SAMA dengan input)",
      "content": "Teks jawaban yang diperbaiki (gunakan Markdown dan \$...\$ untuk rumus)",
      "explanation": "Pembahasan yang sudah diperbaiki (SANGAT JELAS, LENGKAP, dan step-by-step. Gunakan Markdown dan \$...\$ untuk rumus, khusus untuk jawaban benar)"
    }
  ]
}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Tolong berikan JSON perbaikannya sekarang. Pastikan strukturnya tepat sesuai permintaan.' }
    ];

    const response = await callNineRouter(messages, { temperature: 0.2, max_tokens: 3000, response_format: { type: "json_object" } });
    
    // Parse the JSON result
    try {
      const parsed = JSON.parse(response);
      return parsed;
    } catch (e) {
      // In case the model wrapped it in markdown code block
      const cleaned = response.replace(/^```json\n/, '').replace(/\n```$/, '');
      return JSON.parse(cleaned);
    }
  } catch (error) {
    console.error('[9Router] Fix question error:', error.message);
    throw new Error('Gagal melakukan perbaikan AI. Ada gangguan teknis sebentar.');
  }
};

/**
 * AI Generate Fundamental Material
 * Generates reading material for Fundamental UTBK matching the standard text formatting
 */
const generateFundamentalMaterial = async (prompt, subject, topic) => {
  try {
    const systemPrompt = `Kamu adalah AI Pembuat Materi Belajar (Tutor UTBK) profesional untuk platform Stubia.
Tugasmu adalah membuat materi Fundamental UTBK berdasarkan request user.

Konteks:
- Mata Pelajaran: ${subject || 'Umum'}
- Topik/Bab: ${topic || 'Umum'}

=== STANDAR FORMATTING TEXT (WAJIB DIPATUHI) ===
1. Gunakan format **Markdown** standar untuk menebalkan (**tebal**), memiringkan (*miring*), membuat list (- atau 1.), dan membuat judul/heading (# atau ##).
2. JANGAN menggunakan tag HTML murni (seperti <br>, <p>, <strong>, dll). Gunakan double enter / newline biasa untuk merender paragraf baru.
3. WAJIB menggunakan format KaTeX (\$...\$ untuk inline, dan \$\$...\$\$ untuk block) untuk SEMUA rumus matematika, angka pecahan, variabel matematika (seperti \$x\$, \$y\$), atau simbol kimia.
4. Gunakan bahasa Indonesia yang interaktif, komunikatif, dan mudah dipahami siswa SMA (seperti tutor yang sedang mengajar).
5. Buat materi yang LENGKAP dan TERSTRUKTUR: mulai dari pengantar/konsep dasar, penjabaran materi, contoh soal & pembahasan sederhana, dan kesimpulan/tips cepat.
6. Output HARUS BERUPA TEKS MARKDOWN MURNI (bukan JSON, bukan dibungkus dalam tag markdown \`\`\`markdown \`\`\`). Langsung berikan teks materinya.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Buatkan materi fundamental untuk: ${prompt}` }
    ];

    const response = await callNineRouter(messages, { temperature: 0.7, max_tokens: 4000 });
    
    // Clean up potential markdown blocks wrapping the text
    const cleaned = response.replace(/^```markdown\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
    return cleaned;
  } catch (error) {
    console.error('[9Router] Generate material error:', error.message);
    throw new Error('Gagal melakukan generate materi AI. Ada gangguan teknis sebentar.');
  }
};

/**
 * Specialized Kemendikdasmen Prompt Rules per Mata Pelajaran & Jenjang (SD, SMP, SMA)
 * Sesuai Standar BSKAP Kemendikdasmen & Kurikulum Merdeka
 */
const getTkaKemendikdasmenRules = (subjectTitle = '', educationLevel = 'SMA') => {
  const sub = subjectTitle.toLowerCase();
  const lvl = (educationLevel || 'SMA').toUpperCase();

  let subjectRules = '';

  // 1. MATEMATIKA & MATEMATIKA TINGKAT LANJUT
  if (sub.includes('matematika')) {
    if (lvl === 'SD') {
      subjectRules = `\n*STANDAR KEMENDIKDASMEN - MATEMATIKA (JENJANG SD)*:
- Domain: Bilangan (cacah, bulat, pecahan dasar), Pengukuran (panjang, berat, waktu, luas/keliling bangun datar sederhana), Geometri bangun datar/ruang sederhana, Analisis Data dasar (diagram batang/piktogram).
- Karakteristik Soal: Wajib berbasis masalah kontekstual yang dekat dengan kehidupan sehari-hari anak (bermain, berbelanja, kegiatan sekolah).
- Tingkat Penalaran: Utamakan pemahaman konsep dan pemecahan masalah sederhana (bukan hitungan mekanik hafalan).
- KaTeX: Wajib gunakan $...$ untuk semua angka pecahan, operasi hitung, atau simbol matematika (misal: $\\frac{1}{2}$, $25 \\times 4$).`;
    } else if (lvl === 'SMP') {
      subjectRules = `\n*STANDAR KEMENDIKDASMEN - MATEMATIKA (JENJANG SMP)*:
- Domain: Aljabar (bentuk aljabar, PLSV/PtLSV, SPLDV, relasi & fungsi, persamaan garis lurus), Aritmatika Sosial (untung/rugi, diskon, pajak, bunga tunggal), Geometri & Pengukuran (teorema Pythagoras, lingkaran, bangun ruang sisi datar/lengkung, transformasi geometri), Statistika & Peluang.
- Karakteristik Soal: Soal HOTS berbasis studi kasus/aplikasi nyata (perencanaan anggaran, denah arsitektur, survei data).
- Distraktor: Pengecoh harus berasal dari kesalahan perhitungan konsep aljabar umum (salah tanda minus, salah memindah ruas, salah menerapkan rumus keliling vs luas).`;
    } else {
      const isLanjut = sub.includes('lanjut');
      subjectRules = `\n*STANDAR KEMENDIKDASMEN - MATEMATIKA ${isLanjut ? 'TINGKAT LANJUT' : 'UMUM'} (JENJANG SMA)*:
- Domain: ${isLanjut 
  ? 'Kalkulus (diferensial, integral substitusi/parsial, limit trigonometri), Polinomial & Faktorisasi, Vektor analitis & Geometri Ruang Dimensi Tiga, Matriks & Sistem Persamaan Linier, Trigonometri analitis'
  : 'Fungsi (Komposisi & Invers), Eksponen & Logaritma, Barisan & Deret (Aritmatika, Geometri, Keuangan), Trigonometri dasar, Statistika inferensial dasar & Aturan Pencacahan/Peluang'}.
- Karakteristik Soal: Penalaran tingkat tinggi (C4-C5), pemodelan matematis dari fenomena sains/sosial/ekonomi.
- Ketepatan Notasi: WAJIB gunakan KaTeX $...$ dan $$...$$ yang 100% presisi. Pastikan variabel, persamaan, dan batas-batas integral/limit terdefinisi secara ketat.
- Distraktor: Harus mencerminkan miskonsepsi rumus lanjutan (misal: lupa aturan rantai pada turunan, salah sifat logaritma).`;
    }
  }

  // 2. BAHASA INDONESIA & BAHASA INDONESIA TINGKAT LANJUT
  else if (sub.includes('bahasa indonesia') || sub.includes('indonesia')) {
    if (lvl === 'SD') {
      subjectRules = `\n*STANDAR KEMENDIKDASMEN - BAHASA INDONESIA (JENJANG SD)*:
- Domain: Membaca dan memahami isi teks fiksi/cerita anak atau teks informasi pendek, menemukan ide pokok paragraf, makna kata kontekstual, penggunaan ejaan dasar (huruf kapital, tanda titik, tanda tanya).
- Karakteristik Stimulus: Bacaan harus ramah anak, mendidik, santun, dan panjang teks proporsional (1-2 paragraf).
- Pertanyaan: Uji kemampuan menyimpulkan pesan moral, menemukan informasi tersurat dan tersirat sederhana.`;
    } else if (lvl === 'SMP') {
      subjectRules = `\n*STANDAR KEMENDIKDASMEN - BAHASA INDONESIA (JENJANG SMP)*:
- Domain: Teks Deskripsi, Teks Narasi/Cerpen, Teks Eksposisi, Teks Prosedur, Teks Tanggapan, Teks Diskusi, Kalimat Efektif, Konjungsi antarklausa/antarkalimat, Fakta vs Opini.
- Karakteristik Soal: Uji kemampuan mengidentifikasi gagasan utama, koherensi paragraf, makna ungkapan/majas, dan kritik terhadap isi bacaan.
- PUEBI/EYD V: Pastikan pilihan jawaban dan stimulus mematuhi kaidah penulisan baku.`;
    } else {
      const isLanjut = sub.includes('lanjut');
      subjectRules = `\n*STANDAR KEMENDIKDASMEN - BAHASA INDONESIA ${isLanjut ? 'TINGKAT LANJUT' : 'UMUM'} (JENJANG SMA)*:
- Domain: ${isLanjut 
  ? 'Analisis Teks Akademik/Esai Ilmiah, Kritik dan Esai Sastra (prosa, puisi, drama), Analisis Struktur Makro dan Mikro Teks, Retorika, Stilistika'
  : 'Teks Argumentasi, Editorial, Artikel Opini, Teks Laporan Hasil Observasi, Resensi, Negosiasi, Inferensi Makna Mendalam, Evaluasi Asumsi Penulis, Validitas Argumen'}.
- Standar Literasi: Teks stimulus WAJIB bermakna, kritis, dan berbasis wacana aktual/ilmiah. Pertanyaan TIDAK BOLEH bersifat hafalan definisi atau pencarian kata verbatim (C1), melainkan evaluasi sudut pandang, simpulan logis, dan sintesis informasi.`;
    }
  }

  // 3. BAHASA INGGRIS & BAHASA INGGRIS TINGKAT LANJUT
  else if (sub.includes('inggris') || sub.includes('english')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - BAHASA INGGRIS (JENJANG SMA / ADVANCED)*:
- Domain: Reading Comprehension across genre (Analytical Exposition, Discussion Text, Report, Narrative, Hortatory, News Item), Communicative Purpose, Tone and Attitude of the Author, Detailed & Implicit Information, Word Meaning in Context, Pronoun Referencing, Text Cohesion & Organization.
- Standar Teks: Autentik, berbobot intelektual setara CEFR level B1-B2.
- Karakteristik Opsi: Opsi pengecoh harus memiliki kemiripan struktur tata bahasa (paralel) namun mengandung distorsi logika atau over-generalization dari teks.`;
  }

  // 4. FISIKA (SMA - IPA)
  else if (sub.includes('fisika')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - FISIKA (JENJANG SMA)*:
- Domain: Kinematika & Dinamika Gerak (Hukum Newton, Gravitasi, Gerak Melingkar), Usaha, Energi & Momentum, Fluida Statis & Dinamis, Termodinamika & Teori Kinetik Gas, Gelombang Mekanik, Bunyi & Cahaya, Listrik Statis & Dinamis, Kemagnetan & Induksi Faraday, Fisika Inti & Relativitas.
- Karakteristik Soal: Fenomenologis dan eksperimental. Stimulus harus menggambarkan peristiwa alam atau eksperimen laboratorium dengan data (grafik, tabel percobaan, atau diagram fisis).
- Ketepatan Rumus & Satuan: WAJIB gunakan satuan SI yang konsisten, konvensi tanda positif/negatif yang jelas, serta formula KaTeX $...$ yang tepat.
- Distraktor: Harus bersumber dari kekeliruan konsep (misal: mengabaikan gaya gesek saat licin/kasar, salah menerapkan hukum kekekalan momentum, keliru proyeksi vektor).`;
  }

  // 5. KIMIA (SMA - IPA)
  else if (sub.includes('kimia')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - KIMIA (JENJANG SMA)*:
- Domain: Struktur Atom & Tabel Periodik, Ikatan Kimia & Gaya Antarmolekul, Stoikiometri & Hukum Gas, Termokimia (Hukum Hess, Kalorimetri), Laju Reaksi & Teori Tumbukan, Kesetimbangan Kimia (Le Chatelier), Asam-Basa, Buffer & Hidrolisis, Ksp, Redoks & Elektrokimia (Sel Volta & Elektrolisis), Kimia Organik (Gugus Fungsi & Makromolekul).
- Karakteristik Soal: Menghubungkan tiga level representasi kimia (Makroskopis - Submikroskopis - Simbolik).
- Ketepatan Reaksi: Persamaan reaksi kimia WAJIB setara (balanced) beserta fasa zatnya jika relevan. Gunakan notasi KaTeX untuk indeks rumus (misal: $\\text{H}_2\\text{SO}_4$).
- Distraktor: Pengecoh berasal dari kesalahan perbandingan koefisien reaksi, salah menentukan asam/basa konjugasi, atau salah fasa zat.`;
  }

  // 6. BIOLOGI (SMA - IPA)
  else if (sub.includes('biologi')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - BIOLOGI (JENJANG SMA)*:
- Domain: Biologi Sel (Organel, Transpor Membran), Metabolisme (Enzim, Katabolisme, Anabolisme), Genetika & Sintesis Protein (DNA, RNA, Transkripsi/Translasi), Pola Hereditas & Silsilah (Pedigree), Fisiologi Sistem Organ Manusia & Tumbuhan, Ekologi & Aliran Energi, Bioteknologi & Rekayasa Genetika, Evolusi.
- Karakteristik Soal: Berbasis data riset atau fenomena biologis (diagram siklus, grafik enzim, tabel hasil persilangan genetika).
- Analisis HOTS: Menuntut siswa menganalisis hubungan sebab-akibat biologis (misal: efek inhibitor terhadap kerja enzim, mutasi gen terhadap pembentukan protein), BUKAN sekadar menghafal klasifikasi taksonomi.`;
  }

  // 7. EKONOMI (SMA - IPS)
  else if (sub.includes('ekonomi')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - EKONOMI (JENJANG SMA)*:
- Domain: Kelangkaan & Biaya Peluang, Mekanisme Pasar (Permintaan, Penawaran, Elastisitas, Keseimbangan Pasar), Perilaku Konsumen & Produsen, Pendapatan Nasional & Kesenjangan (Gini Ratio), Inflasi & Kebijakan Moneter/Fiskal, Ketenagakerjaan & Upah, Perdagangan Internasional & Kurs Valuta, APBN/APBD, Akuntansi Perusahaan Jasa & Dagang (Persamaan Dasar, Jurnal Umum, Buku Besar, Penyesuaian, Kertas Kerja).
- Karakteristik Soal: Berbasis data empiris (tabel PDB, kurva pergeseran harga, neraca pembayaran, bukti transaksi keuangan).
- Perhitungan: Rumus elastisitas, fungsi penerimaan/biaya, dan pencatatan debit-kredit akuntansi harus 100% presisi.`;
  }

  // 8. SOSIOLOGI (SMA - IPS)
  else if (sub.includes('sosiologi')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - SOSIOLOGI (JENJANG SMA)*:
- Domain: Nilai & Norma Sosial, Sosialisasi & Penyimpangan, Struktur & Diferensiasi Sosial, Stratifikasi Sosial, Mobilitas Sosial, Kelompok Sosial & Partikularisme, Konflik, Kekerasan & Perdamaian, Perubahan Sosial di Era Digital & Globalisasi, Kearifan Lokal & Pemberdayaan Komunitas, Metode Penelitian Sosial.
- Karakteristik Soal: Berbasis studi kasus nyata dinamika masyarakat Indonesia (isu urbanisasi, segregasi sosial, konflik agraria, fenomena medsos).
- Tingkat Penalaran: Evaluasi harus menggunakan perspektif sosiologis (teori fungsionalisme struktural, teori konflik, interaksionisme simbolik), bukan prasangka moral atau pandangan awam.`;
  }

  // 9. GEOGRAFI (SMA - IPS)
  else if (sub.includes('geografi')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - GEOGRAFI (JENJANG SMA)*:
- Domain: Pendekatan, Konsep & Prinsip Geografi, Pemetaan, Penginderaan Jauh & SIG, Dinamika Litosfer (Tektonisme, Vulkanisme, Seisme, Pelapukan), Dinamika Atmosfer (Unsur Cuaca, Klasifikasi Iklim, Perubahan Iklim Global), Dinamika Hidrosfer (Siklus Air, DAS, Perairan Darat & Laut), Biosfer & Bioma, Antroposfer & Dinamika Kependudukan, Pola Keruangan Desa-Kota, Mitigasi Bencana Alam & Pembangunan Berkelanjutan.
- Karakteristik Soal: Analisis spasial (ruang) berbasis peta tematik, citra inderaja, skema morfologi bentang alam, atau piramida penduduk.`;
  }

  // 10. SEJARAH (SMA - IPS)
  else if (sub.includes('sejarah')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - SEJARAH (JENJANG SMA)*:
- Domain: Konsep Berpikir Sejarah (Diakronik, Sinkronik, Kausalitas, Periodisasi), Sumber Sejarah & Historiografi, Kerajaan Maritim Hindu-Buddha & Islam di Nusantara, Kolonialisme & Perlawanan Daerah, Kebangkitan Nasional & Organisasi Pergerakan, Masa Pendudukan Jepang & Proklamasi, Perjuangan Mempertahankan Kemerdekaan, Demokrasi Parlementer & Terpimpin, Orde Baru, Reformasi 1998, Perang Dunia & Dampaknya bagi Indonesia.
- Karakteristik Soal: Menghindari pertanyaan hafalan tahun/tanggal mutlak (C1). Wajib menuntut analisis kausalitas (faktor pemicu, dampak jangka panjang, dan korelasi antarperistiwa sejarah).`;
  }

  // 11. PPKN / PENDIDIKAN PANCASILA (SMA - IPS)
  else if (sub.includes('ppkn') || sub.includes('pancasila')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - PENDIDIKAN PANCASILA / PPKN (JENJANG SMA)*:
- Domain: Nilai-nilai Pancasila dalam Praktik Penyelenggaraan Negara, UUD NRI Tahun 1945 & Dinamika Ketatanegaraan, Pelanggaran & Penegakan Hak Asasi Manusia (HAM), Sistem Hukum & Peradilan Nasional, Integrasi Nasional dalam Bingkai Bhinneka Tunggal Ika, Wawasan Nusantara & Ketahanan Nasional.
- Karakteristik Soal: Kasus dilema hukum, analisis hak dan kewajiban warga negara, pengujian kasus konstitusi di masyarakat.`;
  }

  // 12. BAHASA ASING (Arab, Jepang, Jerman, Prancis, Mandarin, Korea)
  else if (sub.includes('arab') || sub.includes('jepang') || sub.includes('jerman') || sub.includes('prancis') || sub.includes('mandarin') || sub.includes('korea')) {
    subjectRules = `\n*STANDAR KEMENDIKDASMEN - BAHASA ASING PILIHAN (${subjectTitle.toUpperCase()} - SMA)*:
- Domain: Pemahaman wacana dan dialog situasional autentik, struktur gramatika komunikatif, kosakata tematis kontekstual, fungsi sosial tindak tutur (speech acts).
- Ortografi: Pastikan penulisan huruf/aksara dan harakat/tanda baca asing 100% akurat tanpa kesalahan tipografi.`;
  }

  return `\n*STANDAR JENJANG (${lvl})*: Seluruh analisis soal, estimasi tingkat kesulitan, dan kosa kata wajib disesuaikan dengan perkembangan kognitif siswa jenjang ${lvl}.${subjectRules}`;
};

/**
 * AI Review for TKA (Tes Kemampuan Akademik) according to Kemendikdasmen standards
 */
const reviewTkaQuestion = async (questionData) => {
  try {
    const { content, stimulus, difficulty, choices, questionType, subjectTitle, educationLevel } = questionData;

    const choicesText = (choices || [])
      .map(c => `${c.label}. ${c.content}${c.is_correct ? ' ✅ (jawaban benar)' : ''}${c.is_correct && c.explanation ? `\n   Pembahasan: ${c.explanation}` : ''}`)
      .join('\n');

    const difficultyLabel = difficulty === 'easy' ? 'Mudah' : difficulty === 'hard' ? 'Sulit' : 'Sedang';

    const typeLabel = questionType === 'complex_mc_tf' ? 'Benar/Salah Kompleks' :
                      questionType === 'complex_mc_multi' ? 'Pilihan Ganda Multi-Jawaban' :
                      questionType === 'short_answer' ? 'Isian Singkat' : 'Pilihan Ganda';

    const kemendikdasmenRules = getTkaKemendikdasmenRules(subjectTitle, educationLevel);

    const systemPrompt = `Kamu adalah Quality Assurance AI ahli yang bertugas me-review soal Tes Kemampuan Akademik (TKA) Jenjang ${educationLevel || 'SMA'} untuk platform Stubia sesuai standar kurikulum dan asesmen Kemendikdasmen (Kementerian Pendidikan Dasar dan Menengah).
Tugasmu adalah menganalisis SATU soal secara menyeluruh dan memberikan review terstruktur berdasarkan standar kompetensi dan pedagogis Kemendikdasmen.${kemendikdasmenRules}

=== SOAL TKA YANG AKAN DI-REVIEW ===
Jenjang Pendidikan: ${educationLevel || 'SMA'}
Mata Pelajaran: ${subjectTitle || 'Umum'}
Tipe Soal: ${typeLabel}
Tingkat Kesulitan: ${difficultyLabel}
${stimulus ? `Stimulus/Wacana:\n${stimulus}\n` : ''}
Soal: ${content}

Pilihan Jawaban:
${choicesText}

=== KRITERIA REVIEW KEMENDIKDASMEN (WAJIB DIPATUHI) ===

Kamu HARUS memberikan review dalam format PERSIS seperti di bawah ini. JANGAN mengubah format, header, atau struktur.

**FORMAT OUTPUT (WAJIB):**

📝 KERAPIHAN PENULISAN & KAIDAH BAHASA
[Analisis: cek typo, tanda baca, EYD/PUEBI Edisi V, penggunaan huruf kapital, tanda baca di pilihan jawaban, dan konsistensi terminologi ilmiah baku.]

📋 KESESUAIAN STANDAR KEMENDIKDASMEN & TINGKAT HOTS
[Analisis: apakah soal sesuai Capaian Pembelajaran (CP) Kurikulum Merdeka Kemendikdasmen jenjang ${educationLevel || 'SMA'}? Evaluasi level kognitif berdasarkan Taksonomi Bloom (C4-Analisis, C5-Evaluasi, C6-Kreasi). Soal TIDAK BOLEH sekadar menguji hafalan mekanik (C1-C2). Apakah stimulus benar-benar fungsional dan kontekstual atau hanya hiasan?]

🔤 KUALITAS PILIHAN JAWABAN & DISTRAKTOR
[Analisis: apakah opsi pengecoh (distraktor) disusun berdasarkan miskonsepsi umum peserta didik (common student misconceptions)? Pastikan opsi homogen, masuk akal, dan tidak ada kunci ganda atau ambiguitas.]

💡 KUALITAS PEMBAHASAN & SCAFFOLDING
[Analisis: apakah pembahasan mendidik dan menyajikan alur berpikir (scaffolding) step-by-step yang mudah dipahami? Apakah pembahasan menjelaskan konsep mendasar dan alasan mengapa kunci jawaban benar serta opsi lain salah?]

⭐ SKOR KELAYAKAN: [angka 1-10]/10

🎯 REKOMENDASI PERBAIKAN:
[Berikan 2-5 poin rekomendasi konkret dan actionable sesuai standar Kemendikdasmen.]

=== ATURAN KETAT ===
1. WAJIB gunakan format di atas PERSIS. Jangan tambahkan section lain.
2. WAJIB berikan skor 1-10 dengan format "⭐ SKOR KELAYAKAN: X/10". Berikan skor RENDAH (< 7) jika soal hanya sekadar hafalan atau stimulus tidak fungsional.
3. Analisis harus SPESIFIK merujuk pada isi soal dan mata pelajaran ${subjectTitle || 'TKA'}, BUKAN generik.
4. Gunakan bahasa Indonesia profesional dan edukatif.
5. JANGAN mengarang informasi yang tidak ada di soal.
6. Berikan review yang SANGAT KRITIS, TAJAM, dan JUJUR.
7. ATURAN NOTASI MATEMATIKA:
   - Gunakan tanda dollar berpasangan $...$ untuk setiap rumus/variabel matematika (contoh: $f(x) = 2x + 1$, $\\frac{a}{b}$, $P = 105$).
   - JANGAN PERNAH memasukkan kalimat/kata-kata bahasa Indonesia panjang ke dalam tanda dollar ($...$). Tanda dollar hanya untuk simbol/rumus matematika.`;

    const userMessage = 'Tolong review soal TKA di atas secara menyeluruh berdasarkan standar asesmen Kemendikdasmen.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    return await callNineRouter(messages, { temperature: 0.3, max_tokens: 3000 });
  } catch (error) {
    console.error('[9Router] Review TKA question error:', error.message);
    throw new Error('Gagal melakukan review AI TKA. Ada gangguan teknis sebentar.');
  }
};

/**
 * AI Fix TKA Question
 * Automatically applies fixes to a TKA question based on Kemendikdasmen AI review
 */
const fixTkaQuestion = async (questionData, reviewNotes) => {
  try {
    const { content, stimulus, choices, questionType, difficulty, subjectTitle, educationLevel } = questionData;

    const difficultyLabel = difficulty === 'easy' ? 'Mudah' : difficulty === 'hard' ? 'Sulit' : 'Sedang';

    const choicesText = (choices || [])
      .map(c => `ID: ${c.id}\nLabel: ${c.label}\nIsi: ${c.content}\nBenar: ${c.is_correct}\nPembahasan: ${c.explanation || ''}`)
      .join('\n\n');

    const kemendikdasmenRules = getTkaKemendikdasmenRules(subjectTitle, educationLevel);

    const systemPrompt = `Kamu adalah AI Pembuat Soal yang bertugas MEMPERBAIKI soal Tes Kemampuan Akademik (TKA) Jenjang ${educationLevel || 'SMA'} berdasarkan review standar Kemendikdasmen yang diberikan.
Tugasmu adalah menghasilkan versi perbaikan dari soal ini dalam format JSON yang valid.${kemendikdasmenRules}

=== SOAL TKA ASLI ===
Jenjang: ${educationLevel || 'SMA'}
Mata Pelajaran: ${subjectTitle || 'Umum'}
Tipe Soal: ${questionType || 'multiple_choice'}
Tingkat Kesulitan: ${difficultyLabel}
${stimulus ? `Stimulus/Wacana Asli:\n${stimulus}\n` : ''}
Soal Asli: ${content}

Pilihan Jawaban Asli:
${choicesText}

=== CATATAN REVIEW KEMENDIKDASMEN ===
${reviewNotes || 'Perbaiki typo, tingkatkan level HOTS, perbaiki distraktor pengecoh, dan lengkapi pembahasan sesuai standar Kemendikdasmen.'}

=== FORMAT OUTPUT (WAJIB JSON VALID) ===
Kamu HARUS mengembalikan HANYA sebuah JSON object dengan struktur berikut, tanpa teks tambahan di luar JSON:
{
  "stimulus": "string (stimulus yang sudah diperbaiki atau null jika soal tidak memerlukan stimulus)",
  "content": "string (teks pertanyaan yang sudah diperbaiki)",
  "choices": [
    {
      "id": "string (ID asli pilihan jawaban - JANGAN UBAH ID)",
      "label": "string (label A/B/C/D/E)",
      "content": "string (isi pilihan jawaban yang sudah diperbaiki)",
      "explanation": "string (pembahasan detail untuk pilihan ini, jelaskan mengapa benar atau mengapa salah)"
    }
  ]
}

=== ATURAN PERBAIKAN KEMENDIKDASMEN ===
1. PERTAHANKAN ID setiap pilihan jawaban agar sistem database dapat mengupdate dengan benar.
2. Perbaiki semua kesalahan EYD/PUEBI, ketidakkonsistenan huruf kapital, dan tanda baca.
3. Tingkatkan kualitas stimulus agar kontekstual dan fungsional sesuai standar Kemendikdasmen jenjang ${educationLevel || 'SMA'}.
4. Perbaiki opsi pengecoh agar merefleksikan miskonsepsi konsep yang nyata.
5. Lengkapi pembahasan untuk SETIAP opsi (terutama opsi benar wajib memiliki penjelasan langkah demi langkah / scaffolding konseptual yang jelas).
6. Gunakan notasi KaTeX ($...$ atau $$...$$) untuk setiap rumus/simbol matematika. JANGAN memasukkan teks bahasa Indonesia ke dalam tanda dollar ($...$).
7. JANGAN mengubah jawaban yang benar menjadi salah.
8. Output HARUS berupa JSON murni yang valid tanpa awalan atau akhiran teks apapun.`;

    const userMessage = 'Tolong perbaiki soal TKA di atas berdasarkan catatan review Kemendikdasmen. Kembalikan dalam format JSON yang sudah ditentukan.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    const response = await callNineRouter(messages, { temperature: 0.2, max_tokens: 4000 });

    try {
      const parsed = JSON.parse(response);
      return parsed;
    } catch (e) {
      const cleaned = response.replace(/^```json\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
      return JSON.parse(cleaned);
    }
  } catch (error) {
    console.error('[9Router] Fix TKA question error:', error.message);
    throw new Error('Gagal melakukan perbaikan AI TKA. Ada gangguan teknis sebentar.');
  }
};

module.exports = { 
  chatWithStu, 
  chatKonsultasi, 
  chatDiscussQuestion, 
  reviewQuestion, 
  fixQuestion, 
  generateFundamentalMaterial,
  reviewTkaQuestion,
  fixTkaQuestion,
  getTkaKemendikdasmenRules
};

