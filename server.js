const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

// --- CONFIGURATION ---
const QUESTIONS = require('./questions.json');
const DB_FILE = 'game-state.json';
const PORT = 3000;
const ADMIN_PASSWORD = "admin";
const DEFAULT_DURATION = 30;

// --- STATE ---
let gameState = {
    phase: 'REGISTRATION',
    currentQuestionIndex: -1,
    questionEndTime: 0, // NEW: Timestamp based timer
    aliveCount: 0,
    presenterMode: 'GAME',
    questionStats: {}
};

let players = {};
let saveTimeout = null; // For throttling saves

// --- LOAD STATE ---
if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        const savedData = JSON.parse(rawData);
        gameState = savedData.gameState;
        // Reset volatile timer data on reboot
        gameState.questionEndTime = 0;
        if(gameState.phase === 'QUESTION') gameState.phase = 'REVIEW'; // Safety fallback

        if (!gameState.questionStats) gameState.questionStats = {};
        players = savedData.players;
        console.log('--- RECOVERED STATE ---');
    } catch (e) { console.error('Error recovering DB:', e); }
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));

// --- OPTIMIZATION: Throttled Async Save ---
// Prevents disk I/O from blocking the event loop during high traffic (e.g. 200 bots joining)
function saveState() {
    if (saveTimeout) return; // Save already pending
    saveTimeout = setTimeout(() => {
        const data = { gameState, players };
        fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), (err) => {
            if (err) console.error("Save failed", err);
            saveTimeout = null;
        });
    }, 2000); // Save at most once every 2 seconds
}

// --- GAME LOOP ---
// Reduced frequency from 100ms to 1000ms (1s) to save CPU/Bandwidth
setInterval(() => {
    const now = Date.now();
    let timeRemaining = 0;

    if (gameState.phase === 'QUESTION') {
        // Calculate remaining based on timestamp, not decrement
        timeRemaining = Math.max(0, (gameState.questionEndTime - now) / 1000);

        if (timeRemaining <= 0) {
            endQuestion();
            timeRemaining = 0;
        }
    }

    // Only send essential data
    const pulseData = {
        phase: gameState.phase,
        // Send rounded time for general sync. Clients handle animation locally.
        time: timeRemaining.toFixed(1),
        aliveCount: getAliveCount(),
        presenterMode: gameState.presenterMode
    };

    // Volatile emit: if a client is laggy, drop the packet rather than buffering it
    io.volatile.emit('sync_pulse', pulseData);

}, 1000);

function getAliveCount() {
    // Optimization: Cache this if players > 1000, but for 200 this filter is fast enough
    return Object.values(players).filter(p => p.isAlive).length;
}

function startQuestion(index, customDuration = DEFAULT_DURATION) {
    if (index < 0 || index >= QUESTIONS.length) return;

    const durationSec = parseInt(customDuration) || DEFAULT_DURATION;

    gameState.phase = 'QUESTION';
    gameState.currentQuestionIndex = index;
    // Set absolute end time
    gameState.questionEndTime = Date.now() + (durationSec * 1000);
    gameState.presenterMode = 'GAME';

    // Reset answers
    Object.values(players).forEach(p => { if(p.isAlive) p.currentAnswer = null; });
    saveState();

    const q = QUESTIONS[index];
    // Send 'duration' so clients can start their own precise timers
    const qPacket = {
        index,
        text: q.text,
        options: q.options,
        duration: durationSec
    };

    io.emit('new_question', qPacket);
}

function endQuestion() {
    gameState.phase = 'REVIEW';
    const correctIndex = QUESTIONS[gameState.currentQuestionIndex].correctIndex;
    let eliminatedCount = 0;
    let recentDeadNames = [];

    const answerCounts = [0, 0, 0, 0];

    // Process results
    Object.values(players).forEach(p => {
        if (p.isAlive) {
            // Check Answer
            if (p.currentAnswer !== null && p.currentAnswer >= 0 && p.currentAnswer < 4) {
                answerCounts[p.currentAnswer]++;
            }

            // Kill logic
            if (p.currentAnswer === null || p.currentAnswer !== correctIndex) {
                p.isAlive = false;
                p.deathRound = gameState.currentQuestionIndex;
                eliminatedCount++;
                recentDeadNames.push(p.name);
            }
        }
    });

    gameState.questionStats[gameState.currentQuestionIndex] = answerCounts;
    gameState.aliveCount = getAliveCount();
    saveState();

    const revealPacket = {
        correctIndex,
        eliminatedThisRound: eliminatedCount,
        aliveCount: gameState.aliveCount,
        stats: answerCounts,
        recentDeadNames: recentDeadNames
    };

    io.emit('reveal_answer', revealPacket);
}

function resetGame() {
    gameState = {
        phase: 'REGISTRATION',
        currentQuestionIndex: -1,
        questionEndTime: 0,
        aliveCount: 0,
        presenterMode: 'GAME',
        questionStats: {}
    };
    players = {};
    saveState();
    io.emit('system_reset');
}

io.on('connection', (socket) => {
    // --- RECONNECT LOGIC ---
    socket.on('reconnect_attempt_user', (studentId) => {
        const p = players[studentId];
        if (p) {
            socket.studentId = studentId;
            socket.join('players');

            // Calculate current remaining time for the reconnecting user
            let remaining = 0;
            if(gameState.phase === 'QUESTION') {
                remaining = Math.max(0, (gameState.questionEndTime - Date.now()) / 1000);
            }

            const recoveryData = {
                success: true,
                player: { name: p.name, studentId: p.studentId, isAlive: p.isAlive, currentAnswer: p.currentAnswer },
                gameState: { phase: gameState.phase, currentQuestionIndex: gameState.currentQuestionIndex },
                serverTimeRemaining: remaining // Send calculated time
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

    // --- REGISTRATION ---
    socket.on('register', (data) => {
        if (gameState.phase !== 'REGISTRATION') return socket.emit('error_msg', 'بازی شروع شده است.');
        if (players[data.studentId]) return socket.emit('error_msg', 'این شماره قبلا ثبت شده است.');

        // Minimal object to save memory
        players[data.studentId] = {
            name: data.name,
            studentId: data.studentId,
            isAlive: true,
            currentAnswer: null,
            deathRound: -1
        };

        socket.studentId = data.studentId;
        socket.join('players');
        saveState(); // This is now throttled
        socket.emit('registered_success', players[data.studentId]);

        // Optimization: Don't broadcast stats on every single join.
        // The admin panel will pick it up on the next 2-second poll.
        io.to('presenter_room').emit('stats_update', { totalPlayers: Object.keys(players).length });
    });

    // --- ANSWER SUBMISSION ---
    socket.on('submit_answer', (answerIndex) => {
        if (gameState.phase !== 'QUESTION') return;
        if (!socket.studentId) return;

        const p = players[socket.studentId];
        if (!p || !p.isAlive) return;

        p.currentAnswer = answerIndex;
        // No saveState() here. We save memory state.
        // We only persist to disk at end of question or via throttle.
    });

    // --- PRESENTER ---
    socket.on('presenter_join', () => {
        socket.join('presenter_room');
        const packet = {
            gameState: gameState,
            totalPlayers: Object.keys(players).length,
            alivePlayers: Object.values(players).filter(p => p.isAlive).map(p => ({ name: p.name }))
        };
        // Add time calc
        if(gameState.phase === 'QUESTION') {
            packet.serverTimeRemaining = Math.max(0, (gameState.questionEndTime - Date.now()) / 1000);
        }

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

    socket.on('request_presenter_data', () => {
        // Optimization: Filter creates a new array, only do it if necessary
        const alivePlayers = Object.values(players).filter(p => p.isAlive).map(p => ({ name: p.name }));
        socket.emit('presenter_data', { alivePlayers });
    });

    // --- ADMIN ---
    socket.on('admin_auth', (password) => {
        if(password === ADMIN_PASSWORD) {
            socket.join('admin_room');
            socket.emit('admin_auth_success');
            // Send initial data
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
                    // Efficient socket lookup
                    const s = io.sockets.sockets.get(Array.from(io.sockets.sockets.keys()).find(id => {
                        const s = io.sockets.sockets.get(id);
                        return s && s.studentId === cmd.studentId;
                    }));
                    if(s) s.emit('force_disconnect');
                } break;
            case 'REVIVE_PLAYER':
                if(players[cmd.studentId]) {
                    players[cmd.studentId].isAlive = true;
                    saveState();
                    io.emit('player_revived', { id: cmd.studentId, type: 'single' });
                } break;
            case 'REVIVE_ALL':
                Object.values(players).forEach(p => p.isAlive = true);
                saveState();
                io.emit('player_revived', { type: 'all' });
                break;
            case 'REVIVE_ROUND':
                const revivedIds = [];
                Object.values(players).forEach(p => {
                    if(!p.isAlive && p.deathRound === gameState.currentQuestionIndex) {
                        p.isAlive = true;
                        revivedIds.push(p.studentId);
                    }
                });
                saveState();
                if(revivedIds.length > 0) io.emit('player_revived', { type: 'list', ids: revivedIds });
                break;
        }
        // Don't emit full admin data here immediately if it's huge.
        // The admin polling loop will catch it in 2s.
        // OR send it if actions are rare. Actions are rare, so sending it is fine.
        io.to('admin_room').emit('admin_data', { players, gameState, allQuestions: QUESTIONS });
    });

    socket.on('request_admin_data', () => {
        if(!socket.rooms.has('admin_room')) return;
        socket.emit('admin_data', { players, gameState, allQuestions: QUESTIONS });
    });
});

server.listen(PORT, () => console.log(`Server optimized running on port ${PORT}`));