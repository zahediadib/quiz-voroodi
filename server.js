const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONFIGURATION ---
const QUESTIONS = require('./questions.json');
const DB_FILE = 'game-state.json';
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin";
const DEFAULT_DURATION = 30;

// --- STATE ---
let gameState = {
    phase: 'REGISTRATION',
    currentQuestionIndex: -1,
    timeRemaining: 0,
    aliveCount: 0,
    presenterMode: 'GAME',
    questionStats: {}
};

let players = {};

if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        const savedData = JSON.parse(rawData);
        gameState = savedData.gameState;
        if (!gameState.questionStats) gameState.questionStats = {};
        players = savedData.players;
        console.log('--- RECOVERED STATE ---');
    } catch (e) { console.error('Error recovering DB:', e); }
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));

function saveState() {
    const data = { gameState, players };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function gameLoop() {
    if (gameState.phase === 'QUESTION') {
        gameState.timeRemaining = Math.max(0, gameState.timeRemaining - 0.1);
        if (gameState.timeRemaining <= 0) endQuestion();
    }

    const pulseData = {
        phase: gameState.phase,
        time: gameState.timeRemaining.toFixed(1),
        aliveCount: getAliveCount(),
        presenterMode: gameState.presenterMode
    };

    io.to('players').to('admin_room').to('presenter_room').emit('sync_pulse', pulseData);

    const delay = (gameState.phase === 'QUESTION') ? 100 : 500;
    setTimeout(gameLoop, delay);
}
gameLoop();

function getAliveCount() { return Object.values(players).filter(p => p.isAlive).length; }

function startQuestion(index, customDuration = DEFAULT_DURATION) {
    if (index < 0 || index >= QUESTIONS.length) return;

    gameState.phase = 'QUESTION';
    gameState.currentQuestionIndex = index;
    gameState.timeRemaining = parseInt(customDuration) || DEFAULT_DURATION;
    gameState.presenterMode = 'GAME';

    Object.values(players).forEach(p => { if(p.isAlive) p.currentAnswer = null; });
    saveState();

    const q = QUESTIONS[index];
    const qPacket = { index, text: q.text, options: q.options, totalTime: gameState.timeRemaining };
    io.to('players').to('admin_room').to('presenter_room').emit('new_question', qPacket);
}

function endQuestion() {
    gameState.phase = 'REVIEW';
    const correctIndex = QUESTIONS[gameState.currentQuestionIndex].correctIndex;
    let eliminatedCount = 0;
    let recentDeadNames = []; // List of people who died THIS round

    const answerCounts = [0, 0, 0, 0];
    Object.values(players).forEach(p => {
        if (p.isAlive && p.currentAnswer !== null && p.currentAnswer >= 0 && p.currentAnswer < 4) {
            answerCounts[p.currentAnswer]++;
        }
    });

    gameState.questionStats[gameState.currentQuestionIndex] = answerCounts;

    Object.values(players).forEach(p => {
        if (p.isAlive) {
            if (p.currentAnswer === null || p.currentAnswer !== correctIndex) {
                p.isAlive = false;
                p.deathRound = gameState.currentQuestionIndex;
                eliminatedCount++;
                recentDeadNames.push(p.name); // Collect Name
            }
        }
    });

    gameState.aliveCount = getAliveCount();
    saveState();

    const revealPacket = {
        correctIndex,
        eliminatedThisRound: eliminatedCount,
        aliveCount: gameState.aliveCount,
        stats: answerCounts,
        recentDeadNames: recentDeadNames // Send to clients
    };

    io.to('players').to('admin_room').to('presenter_room').emit('reveal_answer', revealPacket);
}

function resetGame() {
    gameState = {
        phase: 'REGISTRATION',
        currentQuestionIndex: -1,
        timeRemaining: 0,
        aliveCount: 0,
        presenterMode: 'GAME',
        questionStats: {}
    };
    players = {};
    saveState();
    io.to('players').to('admin_room').to('presenter_room').emit('system_reset');
}

io.on('connection', (socket) => {
    socket.on('reconnect_attempt_user', (studentId) => {
        if (players[studentId]) {
            const p = players[studentId];
            socket.studentId = studentId;
            socket.join('players');
            const recoveryData = {
                success: true,
                player: { name: p.name, studentId: p.studentId, isAlive: p.isAlive, currentAnswer: p.currentAnswer },
                gameState: { phase: gameState.phase, currentQuestionIndex: gameState.currentQuestionIndex }
            };
            if (gameState.currentQuestionIndex > -1) {
                const q = QUESTIONS[gameState.currentQuestionIndex];
                recoveryData.currentQuestion = { text: q.text, options: q.options };
                if (gameState.phase === 'REVIEW') recoveryData.correctIndex = q.correctIndex;
            }
            socket.emit('reconnect_result', recoveryData);
        } else {
            socket.emit('reconnect_result', { success: false });
        }
    });

    socket.on('register', (data) => {
        if (gameState.phase !== 'REGISTRATION') { socket.emit('error_msg', 'بازی شروع شده است.'); return; }
        if (players[data.studentId]) { socket.emit('error_msg', 'این شماره قبلا ثبت شده است.'); return; }
        players[data.studentId] = { name: data.name, studentId: data.studentId, isAlive: true, currentAnswer: null, deathRound: -1 };
        socket.studentId = data.studentId;
        socket.join('players');
        saveState();
        socket.emit('registered_success', players[data.studentId]);
        io.to('admin_room').to('presenter_room').emit('stats_update', { totalPlayers: Object.keys(players).length });
    });

    socket.on('submit_answer', (answerIndex) => {
        if (gameState.phase !== 'QUESTION') return;
        if (!socket.studentId || !players[socket.studentId]) return;
        const p = players[socket.studentId];
        if (!p.isAlive) return;
        p.currentAnswer = answerIndex;
    });

    socket.on('presenter_join', () => {
        socket.join('presenter_room');
        const packet = {
            gameState: gameState,
            totalPlayers: Object.keys(players).length, // ADDED: Fix for refresh 0 bug
            alivePlayers: Object.values(players).filter(p => p.isAlive).map(p => ({ name: p.name }))
        };
        if (gameState.currentQuestionIndex > -1) {
            const q = QUESTIONS[gameState.currentQuestionIndex];
            packet.currentQuestion = { text: q.text, options: q.options, index: gameState.currentQuestionIndex };
            if (gameState.phase === 'REVIEW') {
                packet.correctIndex = q.correctIndex;
                packet.stats = gameState.questionStats[gameState.currentQuestionIndex] || [];
            }
        }
        socket.emit('presenter_sync_full', packet);
    });

    socket.on('admin_auth', (password) => {
        if(password === ADMIN_PASSWORD) {
            socket.join('admin_room');
            socket.emit('admin_auth_success');
            socket.emit('admin_data', { players, gameState, allQuestions: QUESTIONS });
        } else { socket.emit('admin_auth_fail'); }
    });

    socket.on('admin_command', (cmd) => {
        if(!socket.rooms.has('admin_room')) return;
        switch (cmd.action) {
            case 'START_SPECIFIC': startQuestion(cmd.index, cmd.duration); break;
            case 'END_QUESTION_NOW': if (gameState.phase === 'QUESTION') endQuestion(); break;
            case 'RESET_ALL': resetGame(); break;
            case 'TOGGLE_PRESENTER_VIEW': gameState.presenterMode = cmd.mode; saveState(); break;
            case 'KICK_PLAYER':
                if (players[cmd.studentId]) {
                    delete players[cmd.studentId]; saveState();
                    const kickedSocket = Array.from(io.sockets.sockets.values()).find(s => s.studentId === cmd.studentId);
                    if(kickedSocket) kickedSocket.emit('force_disconnect');
                } break;
            case 'REVIVE_PLAYER':
                if(players[cmd.studentId]) { players[cmd.studentId].isAlive = true; saveState(); io.to('players').emit('player_revived', { id: cmd.studentId, type: 'single' }); } break;
            case 'REVIVE_ALL':
                Object.values(players).forEach(p => p.isAlive = true); saveState(); io.to('players').emit('player_revived', { type: 'all' }); break;
            case 'REVIVE_ROUND':
                const revivedIds = [];
                Object.values(players).forEach(p => { if(!p.isAlive && p.deathRound === gameState.currentQuestionIndex) { p.isAlive = true; revivedIds.push(p.studentId); } });
                saveState(); if(revivedIds.length > 0) io.to('players').emit('player_revived', { type: 'list', ids: revivedIds }); break;
        }
        io.to('admin_room').emit('admin_data', { players, gameState, allQuestions: QUESTIONS });
    });

    socket.on('request_admin_data', () => {
        if(!socket.rooms.has('admin_room')) return;
        socket.emit('admin_data', { players, gameState, allQuestions: QUESTIONS });
    });

    socket.on('request_presenter_data', () => {
        const alivePlayers = Object.values(players).filter(p => p.isAlive).map(p => ({ name: p.name }));
        socket.emit('presenter_data', { alivePlayers });
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));