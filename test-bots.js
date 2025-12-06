const io = require('socket.io-client');

const URL = 'http://localhost:3000';
const CLIENT_COUNT = 200;

// لیست اسامی فارسی رندوم
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
    const f = firstNames[Math.floor(Math.random() * firstNames.length)];
    const l = lastNames[Math.floor(Math.random() * lastNames.length)];
    return `${f} ${l}`;
}

console.log(`Starting ${CLIENT_COUNT} bots with Persian names...`);

for (let i = 0; i < CLIENT_COUNT; i++) {
    createBot(i);
}

function createBot(index) {
    const socket = io(URL);
    // ساخت شماره دانشجویی فیک: 99000000
    const studentId = (99000000 + index).toString();
    const name = getRandomName();

    socket.on('connect', () => {
        socket.emit('register', { name, studentId });
    });

    socket.on('registered_success', () => {
        if(index % 10 === 0) console.log(`✅ ${name} (${index}) registered.`);
    });

    socket.on('new_question', (data) => {
        const delay = Math.random() * 5000 + 1000;
        setTimeout(() => {
            // شانس خطا زدن (برای تست افکت حذف)
            // مثلا 30 درصد شانس اینکه گزینه غلط (رندوم) بزنه
            const randomAnswer = Math.floor(Math.random() * 4);
            socket.emit('submit_answer', randomAnswer);
        }, delay);
    });
}