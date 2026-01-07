const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

// 💡 Firebase Admin 설정
const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  allowEIO3: true,
});

const rooms = {};
const DEFAULT_MONEY = 7000000;

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
      const calculatedToll = 100000 + landCount * 10000;
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
        name: null,
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
    snapshot.forEach((doc) => {
      users[doc.id] = doc.data();
    });
    return users;
  } catch (e) {
    return null;
  }
}

async function updateDBUser(roomId, idx, userData) {
  await db.collection("online").doc(roomId).collection("users").doc(`user${idx}`)
    .update({
      position: userData.position,
      money: userData.money,
      totalMoney: userData.totalMoney,
      level: userData.level,
      islandCount: userData.islandCount,
    })
    .catch((e) => console.error("DB Update Error:", e));
}

// --- 턴 관리 로직 ---

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const activeIndexes = room.players.map((p) => p.index).sort((a, b) => a - b);
  if (activeIndexes.length === 0) return;

  let currentIndexInList = activeIndexes.indexOf(room.state.currentTurn);
  let nextIndexInList = (currentIndexInList + 1) % activeIndexes.length;

  // 한 바퀴 돌면 전체 턴 감소
  if (nextIndexInList === 0) {
    if (room.state.totalTurn > 0) {
      room.state.totalTurn -= 1;
      console.log(`📉 턴 종료! 남은 턴: ${room.state.totalTurn}`);
    }
  }

  let nextPlayerIndex = activeIndexes[nextIndexInList];

  let safety = 0;
  while (room.state.users[`user${nextPlayerIndex}`]?.type === "D" && safety < activeIndexes.length) {
    nextIndexInList = (nextIndexInList + 1) % activeIndexes.length;
    if (nextIndexInList === 0 && room.state.totalTurn > 0) {
       room.state.totalTurn -= 1;
    }
    nextPlayerIndex = activeIndexes[nextIndexInList];
    safety++;
  }
  room.state.currentTurn = nextPlayerIndex;
  const nextPlayer = room.state.users[`user${nextPlayerIndex}`];

  console.log(`🎲 [턴 교체] Player ${room.state.currentTurn} 차례`);

  // 다음 플레이어가 무인도에 갇힌 상태라면 즉시 팝업 요청을 보냄
  if (nextPlayer && nextPlayer.islandCount > 0) {
    io.to(roomId).emit("request_action", {
      type: "island_event",
      pos: 7,
      playerIndex: nextPlayerIndex,
      islandCount: nextPlayer.islandCount,
    });
  }

  if (nextPlayer?.pendingTravel?.needSelect) {
    console.log(`✈ 예약 여행 시작: Player ${nextPlayerIndex}`);

    io.to(roomId).emit("request_action", {
      type: "travel_select",
      playerIndex: nextPlayerIndex,
    });

    // ⚠️ 주사위 굴림 금지
    return;
  }

  io.to(roomId).emit("update_state", room.state);
}

// --- 소켓 이벤트 핸들링 ---

io.on("connection", (socket) => {
  console.log(`🔌 연결됨: ${socket.id}`);

  // 1. 방 생성 (이부분에서 돈 초기화 문제 해결!)
  socket.on("create_room", async (data) => {
    const roomId = typeof data === "object" ? String(data.roomId) : String(data);
    const localData = typeof data === "object" ? data : null;
    const creator = localData && localData.creator ? localData.creator : { name: "방장", id: socket.id };

    if (!rooms[roomId]) {
      try {
        const roomRef = db.collection("online").doc(roomId);
        const initialBoard = generateInitialBoard();

        await roomRef.set({
          localName: localData?.localName || "알 수 없음",
          localCode: localData?.localCode || "",
          status: "waiting",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          board: initialBoard,
        });

        // DB 초기화
        const usersCol = roomRef.collection("users");
        await Promise.all([
          usersCol.doc("user1").set({ type: "P", name: creator.name, id: creator.id, money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1, card: "N" }),
          usersCol.doc("user2").set({ type: "N", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1, card: "N" }),
          usersCol.doc("user3").set({ type: "N", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1, card: "N" }),
          usersCol.doc("user4").set({ type: "N", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1, card: "N" }),
        ]);

        // ✅ [수정 완료] 메모리 초기화 시에도 user2,3,4에 돈을 넣어줌!
        rooms[roomId] = {
          state: {
            users: {
              user1: { name: creator.name, money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, type: "P", islandCount: 0, level: 1 },
              user2: { type: "N", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 },
              user3: { type: "N", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 },
              user4: { type: "N", money: DEFAULT_MONEY, totalMoney: DEFAULT_MONEY, position: 0, islandCount: 0, level: 1 },
            },
            board: initialBoard,
            currentTurn: 1,
            totalTurn: 20,
            localName: localData?.localName || "",
          },
          players: [],
        };

        socket.emit("join_success", roomId);
        io.emit("room_list", Object.keys(rooms));
      } catch (e) {
        socket.emit("join_failed", "서버 DB 오류");
      }
    }
  });

  socket.on("get_rooms", () => {
    socket.emit("room_list", Object.keys(rooms));
  });

  socket.on("join_room", (roomId) => {
    roomId = String(roomId);
    if (rooms[roomId]) {
      socket.emit("join_success", roomId);
    } else {
      db.collection("online").doc(roomId).get().then((doc) => {
        if (doc.exists) socket.emit("join_success", roomId);
        else socket.emit("join_failed", "방을 찾을 수 없습니다.");
      });
    }
  });

  socket.on("join_game", async ({ roomId }) => {
    roomId = String(roomId);

    if (!rooms[roomId]) {
      try {
        const roomRef = db.collection("online").doc(roomId);
        const roomSnap = await roomRef.get();
        if (roomSnap.exists) {
          const roomData = roomSnap.data();
          const dbUsers = await getPlayersFromDB(roomId);
          const dbBoard = roomData.board || generateInitialBoard();

          rooms[roomId] = {
            state: {
              ...roomData,
              users: dbUsers || {}, // DB에서 불러오므로 여기엔 돈 정보가 다 있음
              board: dbBoard,
            },
            players: rooms[roomId]?.players || [],
          };
        }
      } catch (e) { console.error("❌ 데이터 로드 오류:", e); }
    } else {
      try {
        const roomRef = db.collection("online").doc(roomId);
        const roomSnap = await roomRef.get();
        if (roomSnap.exists) {
          const dbData = roomSnap.data();
          if (dbData.board) rooms[roomId].state.board = dbData.board;
        }
      } catch (e) { }
    }

    const room = rooms[roomId];
    if (!room) return;

    let player = room.players.find((p) => p.id === socket.id);
    if (!player && room.players.length < 4) {
      const assigned = room.players.map((p) => p.index);
      let idx = 1;
      while (assigned.includes(idx)) idx++;

      player = { id: socket.id, index: idx };
      room.players.push(player);

      // 입장 시 메모리 업데이트
      if (room.state.users[`user${idx}`]) {
        room.state.users[`user${idx}`].type = "P";
        room.state.users[`user${idx}`].name = `Player ${idx}`;
        room.state.users[`user${idx}`].id = socket.id;
        // 돈이 이미 메모리에 있으므로 굳이 다시 안 넣어도 되지만 안전장치
        if (!room.state.users[`user${idx}`].money) {
           room.state.users[`user${idx}`].money = DEFAULT_MONEY;
           room.state.users[`user${idx}`].totalMoney = DEFAULT_MONEY;
        }
      }

      db.collection("online").doc(roomId).collection("users").doc(`user${idx}`)
        .update({ type: "P", name: `Player ${idx}`, id: socket.id });

      socket.join(roomId);
    }

    socket.emit("init_data", { myIndex: player ? player.index : 0, state: room.state });
    io.to(roomId).emit("update_state", room.state);
  });

  socket.on("roll_dice", ({ roomId }) => {
    roomId = String(roomId);
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || room.state.currentTurn !== player.index) return;

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const steps = 21;
    const isDouble = d1 === d2;

    io.to(roomId).emit("dice_animation", { playerIndex: player.index, d1, d2, isDouble });

    setTimeout(async () => {
      const user = room.state.users[`user${player.index}`];
      if (!user) return;

      if (user.islandCount > 0) {
        if (isDouble) {
          user.islandCount = 0; // 더블이면 즉시 탈출
          console.log(`🎲 Player ${player.index} 더블로 무인도 탈출!`);
        } else {
          user.islandCount -= 1;
          console.log(`🏝️ Player ${player.index} 무인도 대기. 남은 턴: ${user.islandCount}`);

          // 이동하지 않고 상태만 업데이트 후 턴 종료
          await db.collection("online").doc(roomId).collection("users").doc(`user${player.index}`).update({
            islandCount: user.islandCount,
          });
          io.to(roomId).emit("update_state", room.state);
          return nextTurn(roomId);
        }
      }

      io.to(roomId).emit("move_player", {
        playerIndex: player.index,
        steps: steps,
        isDouble: isDouble,
      });
    }, 2200);
  });

  socket.on("travel_move", ({ roomId, playerIndex, targetPos, updateData, isDouble }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.state.users[`user${playerIndex}`];
    if (!user) return;

    const oldPos = user.position;

    // ⭐ travel 카드 이동 플래그
    user._fromTravel = true;

    const steps = (targetPos - oldPos + 28) % 28;

    console.log(`✈ travel_move: ${oldPos} → ${targetPos} (${steps}칸)`);

    // ❗ 위치는 아직 바꾸지 않는다
    socket.emit("move_complete", {
      roomId,
      playerIndex,
      finalPos: targetPos,
      isDouble: false,
    });
  });

  socket.on("move_complete", async ({ roomId, playerIndex, finalPos, isDouble }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.state.users[`user${playerIndex}`];

    const oldPos = user.position || 0;
    user.position = finalPos;

    // ✅ [수정] 이동 후 위치를 여기서 확정
    user.position = finalPos;

    // ✅ [수정] 시작점 통과 여부 확인 (한바퀴 돌았을 때)
    const passedStart = finalPos < oldPos;

    if (passedStart) {
      console.log(`💰 Player ${playerIndex} 시작점 통과! 월급 지급 & 레벨업.`);
      user.money += 1000000;
      user.totalMoney = (user.totalMoney || 0) + 1000000;

      if (!user.level) user.level = 1;
      if (user.level < 4) user.level += 1;
    }

    if (user.position === 7) {
      user.islandCount = 3;
      await db.collection("online").doc(roomId).collection("users").doc(`user${playerIndex}`).update({
        position: user.position,
        islandCount: user.islandCount,
        money: user.money,
        totalMoney: user.totalMoney,
        level: user.level,
      });
      io.to(roomId).emit("update_state", room.state);
      return nextTurn(roomId);
    }

    if (user._fromTravel) {
      user._fromTravel = false;
      io.to(roomId).emit("update_state", room.state);
      return nextTurn(roomId);
    }
    // DB 업데이트 (이동 및 월급/레벨업 반영)
    await db
      .collection("online")
      .doc(roomId)
      .collection("users")
      .doc(`user${playerIndex}`)
      .update({
        position: user.position,
        money: user.money,
        totalMoney: user.totalMoney,
        level: user.level,
        islandCount: user.islandCount,
      })
      .catch((e) => console.error("DB 업데이트 오류:", e));

    await updateDBUser(roomId, playerIndex, user);
    io.to(roomId).emit("update_state", room.state);

    const tile = room.state.board[`b${user.position}`] || { type: "none" };

    if (tile.type === "start") {
      io.to(roomId).emit("request_action", { type: "start_event", playerIndex });
    } else if (tile.type === "festival") {
      io.to(roomId).emit("request_action", { type: "festival_event", pos: user.position, playerIndex });
    } else if (tile.type === "travel") {
      io.to(roomId).emit("request_action", { type: "travel_event", pos: user.position, playerIndex });
    } else if (tile.type === "chance") {
      io.to(roomId).emit("request_action", { type: "chance", pos: user.position, playerIndex, isDouble });
    } else if (tile.type === "tax") {
      let totalBuildingValue = 0;
      const levelMultipliers = [0, 1, 3, 7, 15];
      for (let key in room.state.board) {
        const boardTile = room.state.board[key];
        if (boardTile.owner?.toString() === playerIndex.toString()) {
          const currentLevel = boardTile.level || 0;
          const basePrice = boardTile.tollPrice || 0;
          if (currentLevel > 0) totalBuildingValue += basePrice * levelMultipliers[currentLevel];
        }
      }
      const calculatedTax = Math.floor(totalBuildingValue * 0.1);
      io.to(roomId).emit("request_action", {
        type: "tax_event",
        pos: user.position,
        playerIndex: playerIndex,
        tax: calculatedTax,
        isDouble: isDouble,
      });
    } else if (tile.type === "land") {
      const noOwner = !tile.owner || tile.owner === "N" || tile.owner === "0" || tile.owner === 0;
      const isMyProperty = !noOwner && tile.owner.toString() === playerIndex.toString();

      if (noOwner || isMyProperty) {
        return io.to(roomId).emit("request_action", {
          type: "land_event",
          pos: user.position,
          playerIndex: playerIndex,
          isDouble: isDouble,
        });
      } else {
        let levelMulti = [0, 2, 6, 14, 30][tile.level || 0];
        let toll = tile.tollPrice * (tile.multiply || 1) * levelMulti;
        io.to(roomId).emit("request_action", {
          type: "toll_event",
          pos: user.position,
          playerIndex: playerIndex,
          toll,
          ownerIndex: tile.owner,
          isDouble: isDouble,
        });
      }
    } else if (tile.type === "tax") {
      const userKey = `user${playerIndex}`;
      let totalBuildingValue = 0;
      const levelMultipliers = [0, 1, 3, 7, 15];

      for (let key in room.state.board) {
        const boardTile = room.state.board[key];
        if (boardTile.owner?.toString() === playerIndex.toString()) {
          const currentLevel = boardTile.level || 0;
          const basePrice = boardTile.tollPrice || 0;
          if (currentLevel > 0) {
            totalBuildingValue += basePrice * levelMultipliers[currentLevel];
          }
        }
      }
      const calculatedTax = Math.floor(totalBuildingValue * 0.1);

      return io.to(roomId).emit("request_action", {
        type: "tax_event",
        pos: user.position,
        playerIndex: playerIndex,
        tax: calculatedTax,
        isDouble: isDouble,
      });
    } else {
      // 이벤트 없는 칸이면 턴 종료 (더블일 경우 턴 유지)
      if (isDouble) {
        return io.to(roomId).emit("update_state", room.state);
      } else {
        return nextTurn(roomId);
      }
    }
  });
  socket.on("reserve_travel", ({ roomId, playerIndex }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.state.users[`user${playerIndex}`];
    if (!user) return;

    // ⭐ 여행 예약만
    user.pendingTravel = { needSelect: true };

    console.log(`✈ Player ${playerIndex} 국내여행 예약 → 턴 종료`);

    io.to(roomId).emit("update_state", room.state);

    // ✅ 여기서 반드시 턴 종료
    nextTurn(roomId);
  });

  socket.on("island_wait_complete", ({ roomId, playerIndex }) => {
    const room = rooms[roomId];
    if (!room) return;
    console.log(`🏝 Player ${playerIndex} 무인도 팝업 확인 - 주사위 대기`);
    io.to(roomId).emit("update_state", room.state);
  });

  socket.on("action_complete", async ({ roomId, stateUpdate, isDouble }) => {
    const room = rooms[roomId];
    if (!room) return;

    try {
      const roomRef = db.collection("online").doc(roomId);
      let isIslandEscape = false;

      if (stateUpdate.board) {
        let bUpdates = {};
        for (let bKey in stateUpdate.board) {
          room.state.board[bKey] = { ...room.state.board[bKey], ...stateUpdate.board[bKey] };
          if (stateUpdate.board[bKey].level !== undefined)
            bUpdates[`board.${bKey}.level`] = stateUpdate.board[bKey].level;
          if (stateUpdate.board[bKey].owner !== undefined)
            bUpdates[`board.${bKey}.owner`] = stateUpdate.board[bKey].owner;
        }
        if (Object.keys(bUpdates).length > 0) await roomRef.update(bUpdates);
      }

      if (stateUpdate.users) {
        for (let uKey in stateUpdate.users) {
          if (room.state.users[uKey]) {
            if (stateUpdate.users[uKey].islandCount === 0 && room.state.users[uKey].islandCount > 0) isIslandEscape = true;

            const userDocId = uKey;
            const userSnap = await roomRef.collection("users").doc(userDocId).get();
            let currentDbData = userSnap.exists ? userSnap.data() : room.state.users[uKey];
            let updatedUserData = { ...currentDbData, ...stateUpdate.users[uKey] };

            if (stateUpdate.users[uKey].money !== undefined && stateUpdate.users[uKey].totalMoney === undefined) {
              const diff = stateUpdate.users[uKey].money - (currentDbData.money || 0);
              updatedUserData.totalMoney = (currentDbData.totalMoney || 0) + diff;
            }

            room.state.users[uKey] = updatedUserData;
            await roomRef.collection("users").doc(userDocId).update(updatedUserData);
          }
        }
      }

      console.log(`✅ [액션 완료] 방: ${roomId}, 더블: ${isDouble}, 탈출: ${isIslandEscape}`);

      if (isIslandEscape) {
        io.to(roomId).emit("update_state", room.state);
      } else if (isDouble) {
        io.to(roomId).emit("update_state", room.state);
      } else {
        nextTurn(roomId);
      }
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("island_wait_complete", ({ roomId }) => {
    const room = rooms[roomId];
    if (room) {
      console.log(`🏝 무인도 대기: 주사위 굴리기 모드`);
      io.to(roomId).emit("update_state", room.state);
    }
  });

  socket.on("player_bankrupt", async ({ roomId, playerIndex }) => {
    const room = rooms[roomId];
    if (!room) return;
    const roomRef = db.collection("online").doc(roomId);
    await roomRef.collection("users").doc(`user${playerIndex}`).update({ type: "D", money: 0 });
    room.state.users[`user${playerIndex}`].type = "D";

    let bUpdates = {};
    for (let key in room.state.board) {
      if (room.state.board[key].owner?.toString() === playerIndex.toString()) {
        room.state.board[key].owner = "N";
        room.state.board[key].level = 0;
        room.state.board[key].multiply = 1;
        room.state.board[key].isFestival = false;
        bUpdates[`board.${key}.owner`] = "N";
        bUpdates[`board.${key}.level`] = 0;
        bUpdates[`board.${key}.multiply`] = 1;
        bUpdates[`board.${key}.isFestival`] = false;
      }
    }
    if (Object.keys(bUpdates).length > 0) await roomRef.update(bUpdates);
    console.log(`💀 [파산] Player ${playerIndex} 퇴장`);
    io.to(roomId).emit("update_state", room.state);
    nextTurn(roomId);
  });

  socket.on("disconnect", () => {
    Object.keys(rooms).forEach((rId) => {
      const r = rooms[rId];
      const pIdx = r.players.findIndex((p) => p.id === socket.id);
      if (pIdx !== -1) {
        r.players.splice(pIdx, 1);
        io.emit("room_list", Object.keys(rooms));
      }
    });
  });
});

server.listen(3000, () => console.log("🚀 온라인 게임 서버 가동 중 (Port 3000)"));
