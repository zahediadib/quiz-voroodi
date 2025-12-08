const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const io = require('socket.io-client');

// --- CONFIGURATION ---
const URL = 'https://sut.liara.run/';
const TOTAL_BOTS = 200;
const THREAD_COUNT = 4; // Splits 200 bots into 4 threads (50 each)
const BOTS_PER_THREAD = TOTAL_BOTS / THREAD_COUNT;

// Persian Names Database
const firstNames = [
    "علی", "محمد", "حسین", "رضا", "امیر", "مهدی", "کامران", "سیاوش", "نیما", "آرش",
    "سارا", "مریم", "زهرا", "نگین", "پریا", "الناز", "شیوا", "رویا", "بهار", "کیمیا",
    "سهیل", "پیمان", "فرزاد", "بابک", "حمید", "سعید", "احسان", "مازیار", "پرهام", "دانیال",
    "فرشاد", "محسن", "بهنام", "سینا", "عرفان", "متین", "شایان", "هومن", "نوید", "شهرام"
];
const lastNames = [
    "رضایی", "محمدی", "حسینی", "احمدی", "کریمی", "موسوی", "جعفری", "صادقی", "رحیمی", "ابراهیمی",
    "هاشمی", "قاسمی", "مرادی", "زارع", "سلیمانی", "اکبری", "علوی", "حیدری", "نجفی", "شریفی",
    "باقری", "کاظمی", "عباسی", "تهرانی", "شیرازی", "تبریزی", "یزدانی", "فراهانی", "خسروی", "دهقان",
    "راد", "نیا", "فر", "پور", "زاده", "دوست", "منش", "پناه", "خانی", "صدر"
];

function getRandomName() {
    return `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
}

// --- MAIN THREAD ---
if (isMainThread) {
    console.log(`🚀 Master: Starting ${TOTAL_BOTS} bots across ${THREAD_COUNT} threads...`);

    let activeWorkers = 0;

    for (let i = 0; i < THREAD_COUNT; i++) {
        const worker = new Worker(__filename, {
            workerData: {
                threadId: i + 1,
                botCount: BOTS_PER_THREAD,
                startId: 99000000 + (i * BOTS_PER_THREAD)
            }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'log') console.log(msg.text);
            if (msg.type === 'error') console.error(msg.text);
        });

        worker.on('exit', () => {
            console.log(`Thread ${i + 1} finished.`);
        });

        activeWorkers++;
    }

} else {
    // --- WORKER THREAD ---
    const { threadId, botCount, startId } = workerData;
    const sockets = [];

    parentPort.postMessage({ type: 'log', text: `🔹 Thread ${threadId}: Initializing ${botCount} bots...` });

    for (let i = 0; i < botCount; i++) {
        // Stagger connections slightly (every 20ms) to prevent local CPU spike
        setTimeout(() => createBot(i), i * 20);
    }

    function createBot(index) {
        const studentId = (startId + index).toString();
        const name = getRandomName();

        // Force websocket transport to reduce handshake overhead
        const socket = io(URL, {
            transports: ['websocket'],
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            forceNew: true
        });

        sockets.push(socket);

        socket.on('connect', () => {
            socket.emit('register', { name, studentId });
        });

        socket.on('connect_error', (err) => {
            // Only log errors, so we know it's a network/server issue
            parentPort.postMessage({ type: 'error', text: `❌ Thread ${threadId} | Bot ${studentId}: Connect Error - ${err.message}` });
        });

        socket.on('disconnect', (reason) => {
            if (reason !== 'io client disconnect') {
                parentPort.postMessage({ type: 'error', text: `cw Thread ${threadId} | Bot ${studentId}: Disconnected - ${reason}` });
            }
        });

        socket.on('registered_success', () => {
            // Keep silent on success to avoid console spam, only log every 50th
            if (index % 50 === 0) {
                parentPort.postMessage({ type: 'log', text: `✅ Thread ${threadId}: Bot ${name} registered.` });
            }
        });

        socket.on('new_question', (data) => {
            // Random delay between 0.5s and 4s
            const delay = Math.random() * 3500 + 500;

            setTimeout(() => {
                // 20% chance to pick wrong answer (0-3), 80% chance to pick random
                const randomAnswer = Math.floor(Math.random() * 4);
                socket.emit('submit_answer', randomAnswer);
            }, delay);
        });
    }
}