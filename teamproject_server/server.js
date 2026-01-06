const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require('firebase-admin');

// 💡 Firebase Admin 설정
const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();
// undefined 값이 있어도 에러를 내지 않고 무시하도록 설정
db.settings({ ignoreUndefinedProperties: true });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    allowEIO3: true
});

const rooms = {};
const DEFAULT_MONEY = 7000000; // 💰 초기 자산 700만 원 통일

// --- Firestore 연동 함수 ---

function generateInitialBoard() {
    const board = {};
    let landCount = 0;

    for (let i = 0; i < 28; i++) {
        const key = `b${i}`;
        let type = "land";
        let name = null;

        if (i === 0) { type = "start"; name = "출발지"; }
        else if (i === 7) { type = "island"; name = "무인도"; }
        else if (i === 14) { type = "festival"; name = "지역축제"; }
        else if (i === 21) { type = "travel"; name = "국내여행"; }
        else if (i === 26) { type = "tax"; name = "국세청"; }
        else if ([3, 10, 17, 24].includes(i)) { type = "chance"; name = "찬스"; }

        const blockData = { index: i, type: type, name: name };

        if (type === "land") {
            const calculatedToll = 100000 + (landCount * 10000);
            let group = 0;
            if (i === 1 || i === 2) group = 1;
            else if (i >= 4 && i <= 6) group = 2;
            else if (i === 8 || i === 9) group = 3;
            else if (i >= 11 && i <= 13) group = 4;
            else if (i === 15 || i === 16) group = 5;
            else if (i >= 18 && i <= 20) group = 6;
            else if (i === 22 || i === 23) group = 7;
            else if (i === 25 || i === 27) group = 8;

            Object.assign(blockData, {
                name: `일반 땅 ${landCount + 1}`,
                level: 0,
                owner: "N",
                tollPrice: calculatedToll,
                isFestival: false,
                multiply: 1,
                group: group,
            });
            landCount++;
        }
        board[key] = blockData;
    }
    return board;
}

async function getPlayersFromDB(roomId) {
    try {
        const usersRef = db.collection("online").doc(String(roomId)).collection("users");
        const snapshot = await usersRef.get();
        if (snapshot.empty) return null;
        let users = {};
        snapshot.forEach(doc => {
            const key = doc.id.replace("user0", "user");
            users[key] = doc.data();
        });
        return users;
    } catch (e) { return null; }
}

// --- 턴 관리 로직 ---

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const activeIndexes = room.players.map(p => p.index).sort((a, b) => a - b);
    if (activeIndexes.length === 0) return;

    let currentIndexInList = activeIndexes.indexOf(room.state.currentTurn);
    let nextIndexInList = (currentIndexInList + 1) % activeIndexes.length;
    let nextPlayerIndex = activeIndexes[nextIndexInList];

    let safety = 0;
    while (room.state.users[`user${nextPlayerIndex}`]?.type === "D" && safety < activeIndexes.length) {
        nextIndexInList = (nextIndexInList + 1) % activeIndexes.length;
        nextPlayerIndex = activeIndexes[nextIndexInList];
        safety++;
    }

    room.state.currentTurn = nextPlayerIndex;
    console.log(`🎲 [턴 교체] Player ${room.state.currentTurn} 차례`);
    io.to(roomId).emit("update_state", room.state);
}

// --- 소켓 이벤트 핸들링 ---

io.on("connection", (socket) => {
    console.log(`🔌 연결됨: ${socket.id}`);

    // ✅ 1. 방 생성 (플레이어 2~4 초기화 누락 없이 수정)
    socket.on("create_room", async (data) => {
        const roomId = typeof data === 'object' ? String(data.roomId) : String(data);
        const localData = typeof data === 'object' ? data : null;
        const creator = (localData && localData.creator) ? localData.creator : { name: "방장", id: socket.id };

        if (!rooms[roomId]) {
            try {
                const roomRef = db.collection("online").doc(roomId);
                const initialBoard = generateInitialBoard();

                await roomRef.set({
                    localName: localData?.localName || "알 수 없음",
                    localCode: localData?.localCode || "",
                    status: "waiting",
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    board: initialBoard
                });

                const usersCol = roomRef.collection("users");
                // 💡 모든 플레이어 700만 원 및 totalMoney 초기화
                await Promise.all([
                    usersCol.doc("user01").set({ type: "P", name: creator.name, id: creator.id, money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 }),
                    usersCol.doc("user02").set({ type: "N", name: "대기중...", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 }),
                    usersCol.doc("user03").set({ type: "N", name: "대기중...", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 }),
                    usersCol.doc("user04").set({ type: "N", name: "대기중...", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 }),
                ]);

                rooms[roomId] = {
                    state: {
                        users: {
                            user1: { name: creator.name, money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, type: "P", islandCount: 0, level: 1 },
                            user2: { name: "대기중...", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, type: "N", islandCount: 0, level: 1 },
                            user3: { name: "대기중...", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, type: "N", islandCount: 0, level: 1 },
                            user4: { name: "대기중...", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, type: "N", islandCount: 0, level: 1 },
                        },
                        board: initialBoard,
                        currentTurn: 1,
                        totalTurn: 20,
                        localName: localData?.localName || ""
                    },
                    players: []
                };

                console.log(`✨ 방 생성 완료: ${roomId}`);
                socket.emit("join_success", roomId);
                io.emit("room_list", Object.keys(rooms));
            } catch (e) {
                console.error("❌ 방 생성 오류:", e);
                socket.emit("join_failed", "서버 DB 오류");
            }
        }
    });
    socket.on("join_room", (roomId) => {
            roomId = String(roomId);
            // 메모리에 없으면 DB에서 확인 시도 (서버 재시작 대응)
            if (rooms[roomId]) {
                socket.emit("join_success", roomId);
            } else {
                db.collection("online").doc(roomId).get().then(doc => {
                    if (doc.exists) {
                        socket.emit("join_success", roomId);
                    } else {
                        socket.emit("join_failed", "방을 찾을 수 없습니다.");
                    }
                });
            }
        });
    // ✅ 2. 게임 참가 (NPC 유저 실제 플레이어로 전환)
    socket.on("join_game", async ({ roomId }) => {
        roomId = String(roomId);

        if (!rooms[roomId]) {
            try {
                const roomRef = db.collection("online").doc(roomId);
                const roomSnap = await roomRef.get();
                if (roomSnap.exists) {
                    const dbUsers = await getPlayersFromDB(roomId);
                    rooms[roomId] = {
                        state: { ...roomSnap.data(), users: dbUsers || {} },
                        players: rooms[roomId]?.players || []
                    };
                }
            } catch (e) { console.error("❌ 데이터 로드 오류:", e); }
        }

        const room = rooms[roomId];
        if (!room) return;

        let player = room.players.find(p => p.id === socket.id);
        if (!player && room.players.length < 4) {
            const assigned = room.players.map(p => p.index);
            let idx = 1;
            while (assigned.includes(idx)) idx++;
            player = { id: socket.id, index: idx };
            room.players.push(player);

            const userKey = `user${idx}`;
            if (room.state.users[userKey]) {
                room.state.users[userKey].type = "P";
                room.state.users[userKey].name = `Player ${idx}`;
                room.state.users[userKey].id = socket.id;

                db.collection("online").doc(roomId).collection("users")
                  .doc(`user0${idx}`).update({ type: "P", name: `Player ${idx}`, id: socket.id });
            }
            socket.join(roomId);
        }

        socket.emit("init_data", { myIndex: player ? player.index : 0, state: room.state });
        io.to(roomId).emit("update_state", room.state);
    });

    // ✅ 3. 주사위 로직 (더블, 월급, 레벨업, 무인도 복구)
    socket.on("roll_dice", ({ roomId }) => {
        roomId = String(roomId);
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || room.state.currentTurn !== player.index) return;

        const d1 = Math.floor(Math.random() * 6) + 1;
        const d2 = Math.floor(Math.random() * 6) + 1;
        const isDouble = (d1 === d2);

        io.to(roomId).emit("dice_animation", { playerIndex: player.index, d1, d2, isDouble });

        setTimeout(async () => {
            const user = room.state.users[`user${player.index}`];
            if (!user) return;

            if (user.islandCount > 0) {
                if (isDouble) {
                    user.islandCount = 0;
                } else {
                    user.islandCount -= 1;
                    return nextTurn(roomId);
                }
            }

            const oldPos = user.position || 0;
            user.position = (oldPos + d1 + d2) % 28;

            // 💰 한 바퀴 완주 처리 (월급 + 레벨업)
            if (oldPos + d1 + d2 >= 28) {
                user.money += 1000000;
                user.totalMoney = (user.totalMoney || 0) + 1000000;
                if ((user.level || 1) < 4) user.level = (user.level || 1) + 1;
            }

            if (user.position === 7) {
                user.islandCount = 3; // 3턴 동안 갇힘
                console.log(`🏝️ Player ${playerIndex} 무인도 입성 (3턴)`);
            }



            io.to(roomId).emit("update_state", room.state);

            // DB 실시간 반영
            db.collection("online").doc(roomId).collection("users").doc(`user0${player.index}`).update({
                position: user.position,
                money: user.money,
                totalMoney: user.totalMoney,
                level: user.level,
                islandCount: user.islandCount
            }).catch(e => console.error(e));

            const tile = room.state.board[`b${user.position}`] || { type: "none" };

            setTimeout(() => {
                if (tile.type === "land") {
                    const noOwner = !tile.owner || tile.owner === "N" || tile.owner === "0" || tile.owner === 0;
                    const isMyProperty = !noOwner && (tile.owner.toString() === player.index.toString());

                    if (noOwner || isMyProperty) {
                        console.log(`🏠 [액션 요청] ${isMyProperty ? "내 땅" : "무소유"} - Player ${player.index}`);
                        // ✅ 여기서 이벤트를 보내고 로직을 종료합니다. (nextTurn 호출 금지)
                        io.to(roomId).emit("request_action", {
                            type: "land_event",
                            pos: user.position,
                            playerIndex: player.index,
                            isDouble
                        });
                        return; // 🔥 중요: 여기서 함수를 끝내서 아래의 nextTurn이 실행되지 않게 함
                    } else {
                        // 남의 땅 통행료 지불 요청
                        let levelMulti = [0, 2, 6, 14, 30][tile.level || 0];
                        let toll = (tile.tollPrice * (tile.multiply || 1) * levelMulti);
                        io.to(roomId).emit("request_action", {
                            type: "toll_event",
                            pos: user.position,
                            playerIndex: player.index,
                            toll,
                            ownerIndex: tile.owner,
                            isDouble
                        });
                        return; // 🔥 중요: 여기서 함수를 끝냄
                    }
                }

                // 땅이 아닌 곳(출발지 등)일 때만 더블 체크 후 턴 넘김
                if (isDouble) {
                    io.to(roomId).emit("update_state", room.state);
                } else {
                    nextTurn(roomId);
                }
            }, 800);
        }, 2200);
    });

    // ✅ 4. 액션 완료 및 자산/보드 동기화 (totalMoney 자동 계산 포함)
    socket.on("action_complete", async ({ roomId, stateUpdate }) => {
        const room = rooms[roomId];
        if (!room) return;

        try {
            const roomRef = db.collection("online").doc(roomId);

            // 1. 보드 업데이트 (메모리 + Firestore)
            if (stateUpdate.board) {
                let bUpdates = {};
                for (let bKey in stateUpdate.board) {
                    // 메모리 갱신
                    room.state.board[bKey] = { ...room.state.board[bKey], ...stateUpdate.board[bKey] };

                    // Firestore 업데이트 객체 생성
                    if (stateUpdate.board[bKey].level !== undefined) bUpdates[`board.${bKey}.level`] = stateUpdate.board[bKey].level;
                    if (stateUpdate.board[bKey].owner !== undefined) bUpdates[`board.${bKey}.owner`] = stateUpdate.board[bKey].owner;
                }
                if (Object.keys(bUpdates).length > 0) await roomRef.update(bUpdates);
            }

            // 2. 유저 자산 업데이트 (핵심 수정 부분)
            if (stateUpdate.users) {
                for (let uKey in stateUpdate.users) {
                    if (room.state.users[uKey]) {
                        const userDocId = uKey.replace("user", "user0");

                        // 💡 중요: 인수는 다이얼로그에서 이미 Firebase를 수정했을 수 있음.
                        // 따라서 Firestore의 현재 값을 먼저 읽어와서 메모리와 동기화합니다.
                        const userSnap = await roomRef.collection("users").doc(userDocId).get();
                        let currentDbData = userSnap.exists ? userSnap.data() : room.state.users[uKey];

                        // 클라이언트가 보낸 새 데이터(money 등)가 있다면 적용
                        let updatedUserData = { ...currentDbData, ...stateUpdate.users[uKey] };

                        // totalMoney 자동 보정 (클라이언트가 money만 보냈을 경우)
                        if (stateUpdate.users[uKey].money !== undefined && stateUpdate.users[uKey].totalMoney === undefined) {
                            const diff = stateUpdate.users[uKey].money - currentDbData.money;
                            updatedUserData.totalMoney = (currentDbData.totalMoney || 0) + diff;
                        }

                        // 메모리 갱신
                        room.state.users[uKey] = updatedUserData;

                        // Firestore 최종 업데이트 (동기화)
                        await roomRef.collection("users").doc(userDocId).update(updatedUserData);
                    }
                }
            }

            console.log(`✅ [액션 완료] 방: ${roomId}, 다음 턴으로 교체`);
            nextTurn(roomId);

        } catch (e) {
            console.error("❌ 액션 완료 처리 오류:", e);
        }
    });

// ✅ 5. 자산 매각 처리 (파산 위기 탈출용)
    socket.on("sell_assets", async ({ roomId, playerIndex, sellKeys, totalEarned }) => {
        const room = rooms[roomId];
        if (!room) return;

        try {
            const roomRef = db.collection("online").doc(roomId);
            const userKey = `user${playerIndex}`;
            const userDocId = `user0${playerIndex}`;

            // 1. 보드 데이터 업데이트 (소유주 초기화)
            let bUpdates = {};
            sellKeys.forEach(key => {
                // 메모리 반영
                if (room.state.board[key]) {
                    room.state.board[key].owner = "N";
                    room.state.board[key].level = 0;
                    room.state.board[key].isFestival = false;
                }
                // DB 반영용 객체 생성
                bUpdates[`board.${key}.owner`] = "N";
                bUpdates[`board.${key}.level`] = 0;
                bUpdates[`board.${key}.isFestival`] = false;
            });

            if (Object.keys(bUpdates).length > 0) await roomRef.update(bUpdates);

            // 2. 유저 돈 증가 (매각 대금 합산)
            const user = room.state.users[userKey];
            user.money += totalEarned;
            // 자산을 판 것이므로 totalMoney(총자산)는 변하지 않거나,
            // 매각가 차액에 따라 보정될 수 있으나 여기선 money만 합산 처리

            await roomRef.collection("users").doc(userDocId).update({
                money: user.money
            });

            console.log(`💰 [자산 매각] Player ${playerIndex}: ${sellKeys.length}개 지역 매각 완료`);

            // 상태 전송 (클라이언트 다이얼로그에서 '위기 탈출' 팝업을 띄울 수 있게 함)
            io.to(roomId).emit("update_state", room.state);

        } catch (e) {
            console.error("❌ 자산 매각 오류:", e);
        }
    });

    // ✅ 6. 파산 확정 처리
    socket.on("player_bankrupt", async ({ roomId, playerIndex }) => {
        const room = rooms[roomId];
        if (!room) return;

        try {
            const roomRef = db.collection("online").doc(roomId);
            const userKey = `user${playerIndex}`;
            const userDocId = `user0${playerIndex}`;

            // 1. 유저 상태 'D' (Dead/Bankrupt)로 변경
            if (room.state.users[userKey]) {
                room.state.users[userKey].type = "D";
                room.state.users[userKey].money = 0;
                room.state.users[userKey].totalMoney = 0;
            }
            await roomRef.collection("users").doc(userDocId).update({
                type: "D",
                money: 0
            });

            // 2. 해당 유저가 소유했던 모든 땅 초기화
            let bUpdates = {};
            for (let key in room.state.board) {
                if (room.state.board[key].owner?.toString() === playerIndex.toString()) {
                    // 메모리 반영
                    room.state.board[key].owner = "N";
                    room.state.board[key].level = 0;
                    room.state.board[key].multiply = 1;
                    room.state.board[key].isFestival = false;

                    // DB 반영
                    bUpdates[`board.${key}.owner`] = "N";
                    bUpdates[`board.${key}.level`] = 0;
                    bUpdates[`board.${key}.multiply`] = 1;
                    bUpdates[`board.${key}.isFestival`] = false;
                }
            }

            if (Object.keys(bUpdates).length > 0) await roomRef.update(bUpdates);

            console.log(`💀 [파산] Player ${playerIndex} 퇴장`);

            // 모든 유저에게 업데이트 전파
            io.to(roomId).emit("update_state", room.state);

            // 턴을 다음 사람으로 강제 전환
            nextTurn(roomId);

        } catch (e) {
            console.error("❌ 파산 처리 오류:", e);
        }
    });

    socket.on("disconnect", () => {
        Object.keys(rooms).forEach(rId => {
            const r = rooms[rId];
            const pIdx = r.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                r.players.splice(pIdx, 1);
                io.emit("room_list", Object.keys(rooms));
            }
        });
    });
});

server.listen(3000, () => console.log("🚀 온라인 게임 서버 가동 중 (Port 3000)"));
