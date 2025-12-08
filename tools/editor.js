const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = 4000; // پورت متفاوت از بازی اصلی

// مسیر فایل سوالات (یک پوشه عقب‌تر)
const Q_FILE = path.join(__dirname, '../questions.json');
const BACKUP_FILE = path.join(__dirname, '../questions.backup.json');

app.use(express.json());
app.use(express.static(__dirname)); // برای اجرای فایل html
app.use(cors());

// دریافت لیست سوالات
app.get('/api/questions', (req, res) => {
    if (fs.existsSync(Q_FILE)) {
        const data = fs.readFileSync(Q_FILE, 'utf8');
        res.json(JSON.parse(data));
    } else {
        res.json([]);
    }
});

// ذخیره سوالات
app.post('/api/save', (req, res) => {
    const newQuestions = req.body;

    // ۱. ابتدا بک‌آپ می‌گیریم
    if (fs.existsSync(Q_FILE)) {
        fs.copyFileSync(Q_FILE, BACKUP_FILE);
    }

    // ۲. ذخیره فایل جدید
    fs.writeFile(Q_FILE, JSON.stringify(newQuestions, null, 2), (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, msg: 'خطا در ذخیره سازی' });
        }
        res.json({ success: true, msg: 'با موفقیت ذخیره شد!' });
    });
});

app.listen(PORT, () => {
    console.log(`✏️  Question Editor running at http://localhost:${PORT}`);
    console.log(`📂 Editing file: ${Q_FILE}`);
});