
// index.js - MAX 1 WhatsApp Bot Enhanced (Bahasa Indonesia)
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { HfInference } = require('@huggingface/inference');

// Konfigurasi
const CONFIG = {
    botName: 'MAX 1',
    adminNumber: '6285183268643@s.whatsapp.net',
    hfApiKey: process.env.HF_API_KEY,
    scheduleFile: './jadwal.json',
    hfModel: 'microsoft/DialoGPT-medium',
    personality: `Kamu adalah MAX 1, AI assistant keren seperti JARVIS dari Iron Man tapi versi santai dan friendly. Karaktermu:
    - Cerdas tapi gaul, bukan robot kaku
    - Suka becanda dan pake bahasa anak muda
    - Kadang sarkastik tapi tetep helpful
    - Panggil user "boss", "bro", atau "kak" 
    - Pake emoji yang relevan
    - Kadang bilang "nih gue bantuin" atau "siap komandan"
    - Kalo ada yang susah bilang "wah ribet nih, tapi santai aja"
    - Respon singkat tapi berkesan`,
    maxContextLength: 8,
    typingDelay: [1000, 2500]
};

// Validasi API Key
if (!CONFIG.hfApiKey) {
    console.error('❌ Error: HF_API_KEY tidak ditemukan di environment variables!');
    process.exit(1);
}

// Inisialisasi Hugging Face
const hf = new HfInference(CONFIG.hfApiKey);

// Penyimpanan konteks percakapan
const conversationContext = new Map();

// Store untuk cron jobs
const activeCronJobs = new Map();

// Server Express untuk keep-alive
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({
        status: 'MAX 1 siap beraksi! 🤖✨',
        uptime: `Udah online ${Math.floor(process.uptime() / 60)} menit`,
        timestamp: new Date().toLocaleString('id-ID'),
        message: 'Your AI assistant is ready to serve! 🚀'
    });
});

app.get('/qr', (req, res) => {
    if (fs.existsSync('qr.png')) {
        res.sendFile('qr.png', { root: '.' });
    } else {
        res.status(404).send('QR code belum ready, boss!');
    }
});

app.listen(PORT, () => console.log(`🖥️ Dashboard ready di port ${PORT}`));

// Database jadwal dengan fitur tanggal
let scheduleData = {
    activeSchedules: [],  // Array untuk jadwal aktif
    reminders: []        // Array untuk reminder settings
};

function loadSchedule() {
    try {
        if (fs.existsSync(CONFIG.scheduleFile)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.scheduleFile, 'utf8'));
            scheduleData = { 
                activeSchedules: data.activeSchedules || [], 
                reminders: data.reminders || [] 
            };
        }
    } catch (error) {
        console.error('Gagal memuat jadwal:', error);
        scheduleData = { activeSchedules: [], reminders: [] };
    }
}

function saveSchedule() {
    try {
        fs.writeFileSync(CONFIG.scheduleFile, JSON.stringify(scheduleData, null, 2));
    } catch (error) {
        console.error('Gagal menyimpan jadwal:', error);
    }
}

// Fungsi untuk parsing tanggal Indonesia
function parseIndonesianDate(dateStr) {
    const months = {
        'januari': 0, 'februari': 1, 'maret': 2, 'april': 3, 'mei': 4, 'juni': 5,
        'juli': 6, 'agustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'desember': 11,
        'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'jun': 5, 'jul': 6, 'agu': 7, 'sep': 8, 'okt': 9, 'nov': 10, 'des': 11
    };
    
    // Format: "1 maret 2024" atau "1/3/2024" atau "1-3-2024"
    const patterns = [
        /(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agu|sep|okt|nov|des)\s+(\d{4})/i,
        /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
        /(\d{1,2})\s+(\d{1,2})\s+(\d{4})/
    ];
    
    for (let pattern of patterns) {
        const match = dateStr.match(pattern);
        if (match) {
            if (pattern === patterns[0]) {
                // Format dengan nama bulan
                const day = parseInt(match[1]);
                const month = months[match[2].toLowerCase()];
                const year = parseInt(match[3]);
                return new Date(year, month, day);
            } else {
                // Format numerik
                const day = parseInt(match[1]);
                const month = parseInt(match[2]) - 1; // JavaScript month is 0-indexed
                const year = parseInt(match[3]);
                return new Date(year, month, day);
            }
        }
    }
    return null;
}

// Fungsi untuk cek apakah jadwal masih aktif
function isScheduleActive(schedule) {
    const today = new Date();
    const endDate = new Date(schedule.endDate);
    return today <= endDate;
}

// Fungsi AI Response dengan gaya JARVIS friendly
async function generateAIResponse(pesan, namaPengirim = 'boss', konteks = []) {
    try {
        // Respons preset untuk pertanyaan umum
        const presetResponses = {
            'hai': ['Hai juga boss! 👋', 'Halo kak! Ada yang bisa gue bantuin? 😊', 'Hai there! Siap melayani! 🤖'],
            'halo': ['Halo boss! 🚀', 'Halo! MAX 1 ready to serve! ✨', 'Hai kak! Gimana kabarnya? 😄'],
            'apa kabar': ['Kabar baik dong! Gue selalu siap bantuin 💪', 'Good as always, boss! 😎', 'Baik banget! Apalagi kalo bisa bantuin kamu 🤗'],
            'terima kasih': ['Sama-sama boss! 😊', 'No problem, bro! Anytime! 👍', 'You\'re welcome! Seneng bisa bantuin 🤖'],
            'makasih': ['Santai aja kak! 😄', 'Siap, boss! Always here untuk bantuin 🚀', 'Makasih balik! 😊']
        };
        
        const pesanLower = pesan.toLowerCase();
        for (let key in presetResponses) {
            if (pesanLower.includes(key)) {
                return presetResponses[key][Math.floor(Math.random() * presetResponses[key].length)];
            }
        }
        
        // Generate AI response untuk pertanyaan kompleks
        const waktuSekarang = new Date().toLocaleTimeString('id-ID');
        const hariIni = new Date().toLocaleDateString('id-ID', { weekday: 'long' });
        
        const prompt = `${CONFIG.personality}
        
        Context: ${hariIni}, ${waktuSekarang}
        User: ${namaPengirim}
        Recent chat: ${konteks.slice(-3).join(' | ')}
        
        User says: "${pesan}"
        MAX 1 (respond in friendly Indonesian, max 50 words):`;

        const response = await hf.textGeneration({
            model: CONFIG.hfModel,
            inputs: prompt,
            parameters: {
                max_new_tokens: 80,
                temperature: 0.9,
                top_p: 0.95,
                repetition_penalty: 1.2
            }
        });

        let cleanResponse = response.generated_text
            .replace(prompt, '')
            .split('\n')[0]
            .trim();
            
        // Fallback jika respons kosong atau aneh
        if (!cleanResponse || cleanResponse.length < 3) {
            const fallbacks = [
                'Interesting, boss! Bisa jelasin lebih detail? 🤔',
                'Hmm, gue butuh info lebih nih. Bisa diperjelas? 😅',
                'Wah, pertanyaan menarik! Tapi butuh konteks lebih dong 🤖',
                'Oke sip! Tapi kayaknya kurang jelas nih, bisa diulang? 😊'
            ];
            return fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }
        
        return cleanResponse;
        
    } catch (error) {
        console.error('Error AI:', error);
        const errorResponses = [
            'Wah, server lagi lemot nih boss! Coba lagi ya? 😅',
            'Oops, ada gangguan kecil. Tunggu sebentar ya kak! 🤖',
            'Sistem lagi overload, boss. Give me a sec! ⚡',
            'Error 404: Otak gue restart dulu! 😂',
            'Maaf kak, koneksi lagi trouble. Repeat please? 🔄'
        ];
        return errorResponses[Math.floor(Math.random() * errorResponses.length)];
    }
}

// Fungsi untuk membuat jadwal baru
function createNewSchedule(input, createdBy) {
    try {
        // Parse input format: "judul: deskripsi | mulai: tanggal | selesai: tanggal | jam: HH:MM"
        const parts = input.split('|').map(part => part.trim());
        const scheduleData = {};
        
        parts.forEach(part => {
            const [key, value] = part.split(':').map(s => s.trim());
            scheduleData[key.toLowerCase()] = value;
        });
        
        if (!scheduleData.judul || !scheduleData.mulai || !scheduleData.selesai || !scheduleData.jam) {
            return { success: false, message: 'Format salah, boss! Butuh: judul, mulai, selesai, dan jam' };
        }
        
        const startDate = parseIndonesianDate(scheduleData.mulai);
        const endDate = parseIndonesianDate(scheduleData.selesai);
        
        if (!startDate || !endDate) {
            return { success: false, message: 'Format tanggal ga valid, kak! Coba: "1 maret 2024" atau "1/3/2024"' };
        }
        
        if (startDate > endDate) {
            return { success: false, message: 'Tanggal mulai ga boleh lebih besar dari tanggal selesai, boss! 📅' };
        }
        
        // Validasi format jam
        const timePattern = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timePattern.test(scheduleData.jam)) {
            return { success: false, message: 'Format jam salah! Contoh: 15:30 atau 09:00' };
        }
        
        const newSchedule = {
            id: Date.now(),
            title: scheduleData.judul,
            description: scheduleData.deskripsi || 'Tidak ada deskripsi',
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            reminderTime: scheduleData.jam,
            createdBy: createdBy,
            createdAt: new Date().toISOString()
        };
        
        return { success: true, schedule: newSchedule };
        
    } catch (error) {
        return { success: false, message: 'Error pas bikin jadwal, boss! Coba format yang bener ya 😅' };
    }
}

// Fungsi untuk mendapatkan jadwal aktif hari ini
function getTodayActiveSchedules() {
    const today = new Date();
    const activeToday = scheduleData.activeSchedules.filter(schedule => {
        const startDate = new Date(schedule.startDate);
        const endDate = new Date(schedule.endDate);
        return today >= startDate && today <= endDate;
    });
    
    if (activeToday.length === 0) {
        return 'Santai aja boss, ga ada jadwal aktif hari ini! 😎🏖️';
    }
    
    let message = '📋 *Jadwal Aktif Hari Ini*\n\n';
    activeToday.forEach((schedule, index) => {
        const endDate = new Date(schedule.endDate);
        const daysLeft = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
        
        message += `${index + 1}. *${schedule.title}*\n`;
        message += `   📝 ${schedule.description}\n`;
        message += `   ⏰ Reminder: ${schedule.reminderTime}\n`;
        message += `   📅 Berakhir: ${endDate.toLocaleDateString('id-ID')}\n`;
        message += `   ⏳ Sisa: ${daysLeft} hari\n\n`;
    });
    
    return message + 'Semangat jalanin semuanya, boss! 💪✨';
}

// Fungsi untuk clear old cron jobs
function clearOldCronJobs() {
    activeCronJobs.forEach((job, key) => {
        job.destroy();
    });
    activeCronJobs.clear();
}

// Fungsi untuk setup reminders yang lebih robust
function setupReminders(sock, targetJid) {
    console.log('🔄 Setting up reminders...');
    
    // Clear existing jobs first
    clearOldCronJobs();
    
    scheduleData.activeSchedules.forEach(schedule => {
        if (isScheduleActive(schedule)) {
            const [hour, minute] = schedule.reminderTime.split(':');
            const cronPattern = `0 ${minute} ${hour} * * *`;
            
            console.log(`⏰ Setting reminder for "${schedule.title}" at ${schedule.reminderTime}`);
            
            try {
                const job = cron.schedule(cronPattern, async () => {
                    if (isScheduleActive(schedule)) {
                        const reminderText = `⏰ *Reminder dari MAX 1*\n\n` +
                            `🎯 ${schedule.title}\n` +
                            `📝 ${schedule.description}\n\n` +
                            `Jangan lupa ya, boss! Semangat! 💪✨`;
                        
                        try {
                            await sock.sendMessage(targetJid, { text: reminderText });
                            console.log(`✅ Reminder sent for: ${schedule.title}`);
                        } catch (error) {
                            console.error('Gagal kirim reminder:', error);
                        }
                    } else {
                        console.log(`❌ Schedule "${schedule.title}" is no longer active`);
                        // Remove inactive schedule
                        scheduleData.activeSchedules = scheduleData.activeSchedules.filter(s => s.id !== schedule.id);
                        saveSchedule();
                    }
                }, {
                    scheduled: true,
                    timezone: "Asia/Jakarta"
                });
                
                activeCronJobs.set(schedule.id, job);
            } catch (error) {
                console.error(`Failed to setup reminder for ${schedule.title}:`, error);
            }
        }
    });
    
    console.log(`✅ Setup ${activeCronJobs.size} active reminders`);
}

// Fungsi utama bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['MAX 1', 'Chrome', '1.0.0']
    });

    // Penanganan koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            QRCode.toFile('qr.png', qr, (err) => {
                if (err) console.error('Gagal menyimpan QR:', err);
                else console.log('📱 QR Code tersimpan! Scan untuk connect');
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting...');
                clearOldCronJobs();
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'open') {
            console.log('🤖 MAX 1 Online! Ready to serve, boss! ✨');
            // Setup reminders setelah koneksi berhasil
            setTimeout(() => {
                setupReminders(sock, CONFIG.adminNumber);
            }, 2000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Penanganan pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            const kontenPesan = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || '';
            const dari = msg.key.remoteJid;
            const pengirim = msg.key.participant || msg.key.remoteJid;
            const namaPengirim = msg.pushName || 'boss';
            const isGroup = dari.endsWith('@g.us');
            const isAdmin = pengirim === CONFIG.adminNumber;
            
            // Update konteks percakapan
            if (!conversationContext.has(dari)) {
                conversationContext.set(dari, []);
            }
            const konteks = conversationContext.get(dari);
            konteks.push(`${namaPengirim}: ${kontenPesan}`);
            if (konteks.length > CONFIG.maxContextLength * 2) {
                konteks.splice(0, CONFIG.maxContextLength);
            }

            // Check apakah bot di-mention atau pesan langsung
            const disebutkan = kontenPesan.toLowerCase().includes('@max1') || 
                              kontenPesan.toLowerCase().includes('max1') ||
                              (isGroup && msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(sock.user.id));
            
            if (!disebutkan && isGroup) return; // Skip jika di grup tapi ga di-mention

            // Simulasi mengetik
            await sock.sendPresenceUpdate('composing', dari);
            const delayMengetik = Math.random() * 
                (CONFIG.typingDelay[1] - CONFIG.typingDelay[0]) + 
                CONFIG.typingDelay[0];
            await new Promise(resolve => setTimeout(resolve, delayMengetik));
            await sock.sendPresenceUpdate('paused', dari);

            // Bersihkan mention dari pesan
            const pesanBersih = kontenPesan
                .replace(/@\d+/g, '')
                .replace(/@max1/gi, '')
                .replace(/max1/gi, '')
                .trim();

            // Handle perintah khusus
            if (pesanBersih.toLowerCase().startsWith('/jadwalbaru')) {
                if (!isAdmin) {
                    return sock.sendMessage(dari, { 
                        text: 'Sorry boss, cuma admin yang bisa bikin jadwal baru! 😅🔒' 
                    });
                }
                
                const jadwalInput = pesanBersih.replace('/jadwalbaru', '').trim();
                if (!jadwalInput) {
                    return sock.sendMessage(dari, {
                        text: `🆕 *Format Jadwal Baru*\n\n` +
                              `Contoh:\n` +
                              `/jadwalbaru judul: Meeting Tim | deskripsi: Bahas project Q1 | mulai: 1 maret 2024 | selesai: 5 maret 2024 | jam: 15:00\n\n` +
                              `Format tanggal bisa:\n` +
                              `• 1 maret 2024\n• 1/3/2024\n• 1-3-2024\n\n` +
                              `Format jam: HH:MM (24 jam)`
                    });
                }
                
                const result = createNewSchedule(jadwalInput, pengirim);
                if (result.success) {
                    scheduleData.activeSchedules.push(result.schedule);
                    saveSchedule();
                    
                    // Re-setup reminders with current group/chat
                    const targetJid = isGroup ? dari : CONFIG.adminNumber;
                    setupReminders(sock, targetJid);
                    
                    return sock.sendMessage(dari, {
                        text: `✅ *Jadwal Berhasil Dibuat!*\n\n` +
                              `🎯 ${result.schedule.title}\n` +
                              `📝 ${result.schedule.description}\n` +
                              `📅 ${new Date(result.schedule.startDate).toLocaleDateString('id-ID')} - ${new Date(result.schedule.endDate).toLocaleDateString('id-ID')}\n` +
                              `⏰ Reminder: ${result.schedule.reminderTime}\n\n` +
                              `Siap boss! Gue bakal ingetin sesuai jadwal! 🤖✨`
                    });
                } else {
                    return sock.sendMessage(dari, { text: result.message });
                }
            }
            
            if (pesanBersih.toLowerCase().includes('jadwal hari ini') || 
                pesanBersih.toLowerCase().includes('jadwal aktif')) {
                return sock.sendMessage(dari, { text: getTodayActiveSchedules() });
            }
            
            if (pesanBersih.toLowerCase().includes('bantuan') || pesanBersih.toLowerCase().includes('help')) {
                return sock.sendMessage(dari, {
                    text: `🤖 *MAX 1 - Your AI Assistant*\n\n` +
                          `*Perintah Available:*\n` +
                          `• @max1 - Panggil gue untuk ngobrol\n` +
                          `• /jadwalbaru - Bikin jadwal baru (admin only)\n` +
                          `• "jadwal hari ini" - Lihat jadwal aktif\n` +
                          `• "bantuan" - Tampilkan menu ini\n\n` +
                          `*Features:*\n` +
                          `✅ Reminder otomatis sesuai jadwal\n` +
                          `✅ Chat natural seperti JARVIS\n` +
                          `✅ Manajemen jadwal dengan tanggal\n\n` +
                          `Ready to assist, boss! 🚀✨`
                });
            }
            
            // Respons natural lainnya
            if (pesanBersih) {
                const responAI = await generateAIResponse(pesanBersih, namaPengirim, konteks);
                konteks.push(`MAX 1: ${responAI}`);
                return sock.sendMessage(dari, { text: responAI });
            }
            
        } catch (error) {
            console.error('Error handling message:', error);
            try {
                await sock.sendMessage(msg.key.remoteJid, { 
                    text: 'Oops, ada error nih boss! Sistem lagi restart, coba lagi ya! 🤖⚡' 
                });
            } catch (e) {
                console.error('Failed to send error message:', e);
            }
        }
    });

    return sock;
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down MAX 1...');
    clearOldCronJobs();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down MAX 1...');
    clearOldCronJobs();
    process.exit(0);
});

// Inisialisasi
loadSchedule();
startBot().catch(err => {
    console.error('Bot startup error:', err);
    clearOldCronJobs();
    setTimeout(() => startBot(), 10000); // Retry after 10 seconds
});