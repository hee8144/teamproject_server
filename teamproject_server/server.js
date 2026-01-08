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

    // 1. 타입 결정
    if (i === 0) {
      type = "start";
      name = "출발지";
    } else if (i === 7) {
      type = "island";
      name = "무인도";
    } else if (i === 14) {
      type = "festival";
      name = "지역축제";
    } else if (i === 21) {
      type = "travel";
      name = "국내여행";
    } else if (i === 26) {
      type = "tax";
      name = "국세청";
    } else if ([3, 10, 17, 24].includes(i)) {
      type = "chance";
      name = "찬스";
    }

    // 2. 기본 데이터 구조 (여기서 owner: "N"을 강제함)
    const blockData = {
      index: i,
      type: type,
      name: name,
      owner: "N", // 반드시 "N"
      level: 0,
      isFestival: false,
      multiply: 1,
      tollPrice: 0,
      group: 0,
    };

    // 3. 땅일 경우 세부 설정 (fullName 등 외부 데이터 오염 차단)
    if (type === "land") {
      blockData.tollPrice = 100000 + landCount * 10000;

      let group = 0;
      if (i === 1 || i === 2) group = 1;
      else if (i >= 4 && i <= 6) group = 2;
      else if (i === 8 || i === 9) group = 3;
      else if (i >= 11 && i <= 13) group = 4;
      else if (i === 15 || i === 16) group = 5;
      else if (i >= 18 && i <= 20) group = 6;
      else if (i === 22 || i === 23) group = 7;
      else if (i === 25 || i === 27) group = 8;

      blockData.group = group;
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
  await db
    .collection("online")
    .doc(roomId)
    .collection("users")
    .doc(`user${idx}`)
    .update({
      position: userData.position,
      money: userData.money,
      totalMoney: userData.totalMoney,
      level: userData.level,
      islandCount: userData.islandCount,
    })
    .catch((e) => console.error("DB Update Error:", e));
}

// 승리 조건 체크 함수 (독점 승리)
function checkWinCondition(board, playerIndex) {
  const playerStr = String(playerIndex);

  // A. 트리플 독점
  let ownedGroups = 0;
  for (let g = 1; g <= 8; g++) {
    let groupTiles = [];
    for (let key in board) {
      if (board[key].type === "land" && board[key].group === g) {
        groupTiles.push(board[key]);
      }
    }
    if (groupTiles.length > 0) {
      const allMine = groupTiles.every((t) => String(t.owner) === playerStr);
      if (allMine) ownedGroups++;
    }
  }
  if (ownedGroups >= 3) return "triple_monopoly";

  // B. 라인 독점
  const lines = [
    { start: 0, end: 7 },
    { start: 7, end: 14 },
    { start: 14, end: 21 },
    { start: 21, end: 28 },
  ];
  for (let line of lines) {
    let hasLand = false;
    let lineMonopoly = true;
    for (let i = line.start; i < line.end; i++) {
      const tile = board[`b${i}`];
      if (tile && tile.type === "land") {
        hasLand = true;
        if (String(tile.owner) !== playerStr) {
          lineMonopoly = false;
          break;
        }
      }
    }
    if (hasLand && lineMonopoly) return "line_monopoly";
  }
  return null;
}

// ⚠️ [추가됨] 독점 경고 체크 함수 (승리 직전 상태인지 확인)
function checkWarningCondition(board, playerIndex) {
  const playerStr = String(playerIndex);

  // 1. 라인 독점 경고 체크 (해당 라인의 땅을 1개 빼고 다 먹었을 때)
  const lines = [
    { start: 0, end: 7 },
    { start: 7, end: 14 },
    { start: 14, end: 21 },
    { start: 21, end: 28 },
  ];

  for (let line of lines) {
    let ownedCount = 0;
    let totalLandCount = 0;

    for (let i = line.start; i < line.end; i++) {
      const tile = board[`b${i}`];
      if (tile && tile.type === "land") {
        totalLandCount++;
        if (String(tile.owner) === playerStr) {
          ownedCount++;
        }
      }
    }

    // 땅이 존재하는 라인이고, 딱 1개 남았을 때
    if (totalLandCount > 0 && ownedCount === totalLandCount - 1) {
      return "line"; // 라인 독점 경고 리턴
    }
  }

  // 2. 트리플 독점 경고 체크 (2개 그룹 독점 + 나머지 1개 그룹이 1개 남았을 때)
  let fullGroups = 0;
  let almostGroups = 0;

  for (let g = 1; g <= 8; g++) {
    let groupTiles = [];
    for (let key in board) {
      if (board[key].type === "land" && board[key].group === g) {
        groupTiles.push(board[key]);
      }
    }

    if (groupTiles.length > 0) {
      const owned = groupTiles.filter(t => String(t.owner) === playerStr).length;
      if (owned === groupTiles.length) {
        fullGroups++;
      } else if (owned === groupTiles.length - 1) {
        almostGroups++;
      }
    }
  }

  // 트리플 독점 조건(3그룹)에 1개 부족한 상황
  if (fullGroups >= 2 && almostGroups >= 1) {
    return "triple"; // 트리플 독점 경고 리턴
  }

  return null; // 경고 없음
}

// --- 턴 관리 로직 ---

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const activeIndexes = room.players.map((p) => p.index).sort((a, b) => a - b);
  if (activeIndexes.length === 0) return;

  let currentIndexInList = activeIndexes.indexOf(room.state.currentTurn);
  let nextIndexInList = (currentIndexInList + 1) % activeIndexes.length;
  let nextPlayerIndex = activeIndexes[nextIndexInList];

  // 한 바퀴 돌았을 때 턴 감소
  if (nextIndexInList === 0) {
    if (room.state.totalTurn > 0) {
      room.state.totalTurn -= 1;
      console.log(`📉 턴 종료! 남은 턴: ${room.state.totalTurn}`);
    }

    // 턴 0되면 게임 종료
    if (room.state.totalTurn <= 0) {
        let maxMoney = -999999999;
        let winnerIdx = 0;
        for (let i = 1; i <= 4; i++) {
            const u = room.state.users[`user${i}`];
            if (u && u.type !== 'D' && u.type !== 'N') {
                if (u.totalMoney > maxMoney) {
                    maxMoney = u.totalMoney;
                    winnerIdx = i;
                }
            }
        }
        console.log(`🏁 턴 종료! 승자: Player ${winnerIdx} (자산: ${maxMoney})`);
        io.to(roomId).emit("game_over", { winner: winnerIdx, type: "turn_limit" });
        return;
    }
  }

  // 파산한 플레이어 건너뛰기
  let safety = 0;
  while (safety < activeIndexes.length) {
    const targetUser = room.state.users[`user${nextPlayerIndex}`];

    // Case A: 파산한 플레이어인가?
    if (targetUser?.type === "D") {
      console.log(`💀 Player ${nextPlayerIndex} 파산 - 건너뜁니다.`);
    }
    // Case B: 한 턴 쉬어야 하는 플레이어인가?
    else if (targetUser?.restCount > 0) {
      targetUser.restCount -= 1; // 횟수 차감
      console.log(`😴 Player ${nextPlayerIndex} 휴식 중 - 건너뜁니다. (남은 휴식: ${targetUser.restCount})`);

      // DB 업데이트 (비동기지만 기다리지 않고 진행해도 무방)
      db.collection("online")
        .doc(roomId)
        .collection("users")
        .doc(`user${nextPlayerIndex}`)
        .update({ restCount: targetUser.restCount });
    }
    // Case C: 정상적인 플레이어인가? -> 이 사람 턴으로 확정!
    else {
      break;
    }

    // 다음 인덱스로 이동
    nextIndexInList = (nextIndexInList + 1) % activeIndexes.length;
    if (nextIndexInList === 0 && room.state.totalTurn > 0) {
       room.state.totalTurn -= 1;
       if (room.state.totalTurn <= 0) {
            let maxMoney = -999999999;
            let winnerIdx = 0;
            for (let i = 1; i <= 4; i++) {
                const u = room.state.users[`user${i}`];
                if (u && u.type !== 'D' && u.type !== 'N') {
                    if (u.totalMoney > maxMoney) { maxMoney = u.totalMoney; winnerIdx = i; }
                }
            }
          }
        }
        io.to(roomId).emit("game_over", { winner: winnerIdx, type: "turn_limit" });
        return;
      }
    }
    nextPlayerIndex = activeIndexes[nextIndexInList];
    safety++;
  }

  room.state.currentTurn = nextPlayerIndex;
  const nextPlayer = room.state.users[`user${nextPlayerIndex}`];

  console.log(`🎲 [턴 교체] Player ${nextPlayerIndex} 차례`);
  io.to(roomId).emit("update_state", room.state);

  // 이후 무인도/여행/주사위 활성화 로직 (기존과 동일)
  if (nextPlayer?.islandCount > 0) {
    io.to(roomId).emit("request_action", {
      type: "island_event",
      pos: 7,
      playerIndex: nextPlayerIndex,
      islandCount: nextPlayer.islandCount,
    });
    return;
  }

  if (nextPlayer?.pendingTravel?.needSelect === true) {
    nextPlayer.pendingTravel.needSelect = false;
    io.to(roomId).emit("request_action", { type: "travel_select", playerIndex: nextPlayerIndex });
    return;
  }

  io.to(roomId).emit("enable_roll_dice", { playerIndex: nextPlayerIndex });
}

// 헬퍼 함수: 턴을 감소시키고 0이 되면 게임을 종료함
function reduceTotalTurn(roomId) {
  const room = rooms[roomId];
  if (room.state.totalTurn > 0) {
    room.state.totalTurn -= 1;
  }

  if (room.state.totalTurn <= 0) {
    let maxMoney = -999999999;
    let winnerIdx = 0;
    for (let i = 1; i <= 4; i++) {
      const u = room.state.users[`user${i}`];
      if (u && u.type !== "D" && u.type !== "N") {
        if (u.totalMoney > maxMoney) {
          maxMoney = u.totalMoney;
          winnerIdx = i;
        }
      }
    }
    io.to(roomId).emit("game_over", { winner: winnerIdx, type: "turn_limit" });
    return false; // 게임 종료됨
  }
  return true; // 계속 진행
}

// --- 소켓 이벤트 핸들링 ---

io.on("connection", (socket) => {
  console.log(`🔌 연결됨: ${socket.id}`);

  socket.on("create_room", async (data) => {
    const roomId = typeof data === "object" ? String(data.roomId) : String(data);
    const localData = typeof data === "object" ? data : null;
    const creator = localData && localData.creator ? localData.creator : { name: "방장", id: socket.id };

    if (!rooms[roomId]) {
      try {
        const roomRef = db.collection("online").doc(roomId);
        const initialBoard = generateInitialBoard();

        await roomRef.set(
          {
            localName: localData?.localName || "알 수 없음",
            localCode: localData?.localCode || "",
            status: "waiting",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            board: initialBoard,
          },
          { merge: false }
        );

        const usersCol = roomRef.collection("users");
        await Promise.all([
          usersCol.doc("user1").set({
            type: "P",
            name: creator.name,
            id: creator.id,
            money: DEFAULT_MONEY,
            totalMoney: DEFAULT_MONEY,
            position: 0,
            islandCount: 0,
            level: 1,
            card: "N",
          }),
          usersCol.doc("user2").set({
            type: "N",
            money: DEFAULT_MONEY,
            totalMoney: DEFAULT_MONEY,
            position: 0,
            islandCount: 0,
            level: 1,
            card: "N",
          }),
          usersCol.doc("user3").set({
            type: "N",
            money: DEFAULT_MONEY,
            totalMoney: DEFAULT_MONEY,
            position: 0,
            islandCount: 0,
            level: 1,
            card: "N",
          }),
          usersCol.doc("user4").set({
            type: "N",
            money: DEFAULT_MONEY,
            totalMoney: DEFAULT_MONEY,
            position: 0,
            islandCount: 0,
            level: 1,
            card: "N",
          }),
        ]);

        rooms[roomId] = {
          state: {
            users: {
              user1: {
                name: creator.name,
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                type: "P",
                islandCount: 0,
                level: 1,
              },
              user2: {
                type: "N",
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                islandCount: 0,
                level: 1,
              },
              user3: {
                type: "N",
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                islandCount: 0,
                level: 1,
              },
              user4: {
                type: "N",
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                islandCount: 0,
                level: 1,
              },
            },
            board: initialBoard,
            currentTurn: 1,
            totalTurn: 3,
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
    // 서버 메모리에 방이 이미 있다면 즉시 성공
    if (rooms[roomId]) {
      socket.emit("join_success", roomId);
    } else {
      // 서버 메모리에 없는데 DB에만 있는 경우,
      // 오래된 방일 수 있으므로 체크 후 입장 허용
      db.collection("online")
        .doc(roomId)
        .get()
        .then((doc) => {
          if (doc.exists) {
            socket.emit("join_success", roomId);
          } else {
            socket.emit("join_failed", "방을 찾을 수 없습니다.");
          }
        });
    }
  });

  socket.on("join_game", async ({ roomId }) => {
    roomId = String(roomId);

    if (!rooms[roomId]) {
      // 1. 방이 서버 메모리에 없을 때만 DB에서 가져옴
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
              users: dbUsers || {},
              board: dbBoard,
            },
            players: [],
          };
        }
      } catch (e) {
        console.error("❌ 데이터 로드 오류:", e);
      }
    } else {
      try {
        const roomRef = db.collection("online").doc(roomId);
        const roomSnap = await roomRef.get();
        if (roomSnap.exists) {
          const dbData = roomSnap.data();
          if (dbData.board) {
            rooms[roomId].state.board = dbData.board;
            console.log(`✅ [Sync] Room ${roomId} Board data synchronized with DB (Names Loaded)`);
          }
        }
      } catch (e) {
        console.error("Board sync error:", e);
      }
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

      if (room.state.users[`user${idx}`]) {
        room.state.users[`user${idx}`].type = "P";
        room.state.users[`user${idx}`].name = `Player ${idx}`;
        room.state.users[`user${idx}`].id = socket.id;
        if (!room.state.users[`user${idx}`].money) {
          room.state.users[`user${idx}`].money = DEFAULT_MONEY;
          room.state.users[`user${idx}`].totalMoney = DEFAULT_MONEY;
        }
      }

      db.collection("online")
        .doc(roomId)
        .collection("users")
        .doc(`user${idx}`)
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
    const steps = 3;
    const isDouble = d1 === d2;

    io.to(roomId).emit("dice_animation", { playerIndex: player.index, d1, d2, isDouble });

    setTimeout(async () => {
      const user = room.state.users[`user${player.index}`];
      if (!user) return;

      if (user.islandCount > 0) {
        if (isDouble) {
          user.islandCount = 0;
          console.log(`🎲 Player ${player.index} 더블로 무인도 탈출!`);
        } else {
          user.islandCount -= 1;
          console.log(`🏝️ Player ${player.index} 무인도 대기. 남은 턴: ${user.islandCount}`);

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

  socket.on("travel_move", async ({ roomId, playerIndex, targetPos }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.state.users[`user${playerIndex}`];
    user.isTraveling = true;
    if (!user) return;

    const oldPos = user.position;
    const steps = (targetPos - oldPos + 28) % 28;

    console.log(`✈ travel_move 실행: ${oldPos} → ${targetPos} (${steps}칸 이동)`);

    // 1. 서버 메모리상 위치 미리 업데이트 (애니메이션 시작 전)
    user.position = targetPos;
    user.pendingTravel = { needSelect: false };

    // 2. 클라이언트에 이동 명령 (애니메이션 실행용)
    io.to(roomId).emit("move_player", {
      playerIndex: playerIndex,
      steps: steps,
      isDouble: false,
      isTravel: true,
    });

    // 3. 애니메이션 시간(steps * 400ms) 후에 칸 이벤트 발생시키기
    setTimeout(async () => {
      // 월급 처리 (시작점 통과 여부)
      if (targetPos < oldPos) {
        user.money += 1000000;
        user.totalMoney += 1000000;
        if (!user.level) user.level = 1;
        if (user.level < 4) user.level += 1;
      }

      // DB 업데이트
      await updateDBUser(roomId, playerIndex, user);
      io.to(roomId).emit("update_state", room.state);

      // ⭐ 중요: 여기서 바로 턴을 넘기지 말고, 도착한 칸의 이벤트를 트리거합니다.
      // 기존에 작성하신 move_complete 내부 로직을 별도 함수로 빼거나,
      // 아래와 같이 이벤트 판별 로직을 호출해야 합니다.

      handleTileEvent(roomId, playerIndex, targetPos, false);
    }, steps * 400); // 애니메이션 시간 + 여유시간
  });

  socket.on("move_complete", async ({ roomId, playerIndex, finalPos, isDouble }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.state.users[`user${playerIndex}`];
    const oldPos = user.position || 0;

    // 1. 위치 확정 및 시작점 통과 체크
    user.position = finalPos;
    const passedStart = finalPos < oldPos;

    if (user.isTraveling === true) {
      user.isTraveling = false; // 플래그 초기화 후 종료
      return;
    }
    if (passedStart) {
      console.log(`💰 Player ${playerIndex} 시작점 통과! 월급 지급.`);
      user.money += 1000000;
      user.totalMoney = (user.totalMoney || 0) + 1000000;
      if (!user.level) user.level = 1;
      if (user.level < 4) user.level += 1;
    }

    // 2. 무인도(7번 칸) 예외 처리
    if (finalPos === 7) {
      user.islandCount = 3;
      await updateDBUser(roomId, playerIndex, user);
      io.to(roomId).emit("update_state", room.state);
      return nextTurn(roomId);
    }

    // 3. DB 업데이트 및 상태 동기화
    await updateDBUser(roomId, playerIndex, user);
    io.to(roomId).emit("update_state", room.state);

    // 4. ✨ 중복 로직 대신 함수 호출!
    handleTileEvent(roomId, playerIndex, finalPos, isDouble);
  });
  socket.on("reserve_travel", ({ roomId, playerIndex }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.state.users[`user${playerIndex}`];
    if (!user) return;

    user.pendingTravel = { needSelect: true };

    console.log(`✈ Player ${playerIndex} 국내여행 예약 → 턴 종료`);

    io.to(roomId).emit("update_state", room.state);

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

      // 1. 보드 업데이트
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

      // 2. 유저 업데이트
      if (stateUpdate.users) {
        for (let uKey in stateUpdate.users) {
          if (room.state.users[uKey]) {
            if (stateUpdate.users[uKey].islandCount === 0 && room.state.users[uKey].islandCount > 0)
              isIslandEscape = true;

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

      // 3. 승리 조건 체크 (독점 승리)
      const currentPlayerIndex = room.state.currentTurn;
      const winType = checkWinCondition(room.state.board, currentPlayerIndex);

      if (winType) {
        console.log(`🏆 승리 발생! Player ${currentPlayerIndex} - ${winType}`);
        io.to(roomId).emit("game_over", { winner: currentPlayerIndex, type: winType });
        return;
      }

      // 4. ✅ [추가됨] 경고 조건 체크 (승리가 아닐 때만 확인)
      const warningType = checkWarningCondition(room.state.board, currentPlayerIndex);
      if (warningType) {
        console.log(`⚠️ 독점 경고 발생! Player ${currentPlayerIndex} - ${warningType}`);
        // 모든 클라이언트에게 경고 팝업을 띄우라고 신호 보냄
        io.to(roomId).emit("warning_message", { players: [currentPlayerIndex], type: warningType });
      }

      if (isIslandEscape || isDouble) {
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

    // 파산 처리
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

    // 생존자 확인 (파산 승리)
    let survivors = [];
    Object.keys(room.state.users).forEach((key) => {
      const u = room.state.users[key];
      if (u.type !== "D" && u.type !== "N") {
        survivors.push(parseInt(key.replace("user", "")));
      }
    });

    if (survivors.length === 1) {
      const winnerIdx = survivors[0];
      console.log(`🏆 파산 승리! Player ${winnerIdx}`);
      io.to(roomId).emit("game_over", { winner: winnerIdx, type: "bankruptcy" });
      return; // 게임 종료 (턴 안 넘김)
    }

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

async function handleTileEvent(roomId, playerIndex, position, isDouble) {
  const room = rooms[roomId];
  if (!room) return;
  const user = room.state.users[`user${playerIndex}`];
  const tile = room.state.board[`b${position}`] || { type: "none" };

  console.log(`📍 이벤트 체크: Player ${playerIndex} -> ${tile.type}(${position})`);

  if (position === 7) {
    console.log(`🏝️ Player ${playerIndex} 무인도 입성 (3턴 대기)`);
    user.islandCount = 3;
    await updateDBUser(roomId, playerIndex, user);
    io.to(roomId).emit("update_state", room.state);
    return nextTurn(roomId); // 무인도는 즉시 턴 종료
  }
  if (tile.type === "start") {
    // 1. 플레이어가 소유한 땅이 있는지 확인
    let hasMyLand = false;
    for (let key in room.state.board) {
      if (room.state.board[key].owner?.toString() === playerIndex.toString()) {
        hasMyLand = true;
        break;
      }
    }

    if (hasMyLand) {
      // 소유한 땅이 있으면 평소처럼 랜드마크 건설 팝업 요청
      return io.to(roomId).emit("request_action", { type: "start_event", playerIndex });
    } else {
      // 소유한 땅이 없으면 하이라이트를 띄우지 않고 그냥 턴 종료 (또는 다음 턴)
      console.log(`💰 Player ${playerIndex} 출발지 도착 (소유한 땅 없음 - 패스)`);
      if (isDouble) {
        return io.to(roomId).emit("enable_roll_dice", { playerIndex });
      } else {
        return nextTurn(roomId);
      }
    }
  }

  if (tile.type === "festival") {
    return io.to(roomId).emit("request_action", { type: "festival_event", pos: position, playerIndex });
  }

  if (tile.type === "travel") {
    user.pendingTravel = { needSelect: true };
    await updateDBUser(roomId, playerIndex, user);
    io.to(roomId).emit("update_state", room.state);
    return nextTurn(roomId); // 여행 칸은 바로 턴 종료
  }

  if (tile.type === "chance") {
    return io.to(roomId).emit("request_action", { type: "chance", pos: position, playerIndex, isDouble });
  }

  if (tile.type === "land") {
    const noOwner = !tile.owner || tile.owner === "N" || tile.owner === "0" || tile.owner === 0;
    const isMyProperty = !noOwner && tile.owner.toString() === playerIndex.toString();

    if (noOwner || (isMyProperty && tile.level < 4)) {
      // 💡 [수정] 내 땅이라도 이미 풀빌딩(level 4)이면 팝업을 띄우지 않음
      return io.to(roomId).emit("request_action", {
        type: "land_event",
        pos: position,
        playerIndex: playerIndex,
        isDouble: isDouble,
        canBuild: noOwner || (isMyProperty && tile.level < 4),
      });
    } else if (!noOwner && !isMyProperty) {
      // 남의 땅 통행료
      let levelMulti = [0, 2, 6, 14, 30][tile.level || 0];
      let toll = tile.tollPrice * (tile.multiply || 1) * levelMulti;
      return io.to(roomId).emit("request_action", {
        type: "toll_event",
        pos: position,
        playerIndex: playerIndex,
        toll,
        ownerIndex: tile.owner,
        isDouble: isDouble,
      });
    }
  }

  if (tile.type === "tax") {
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
    return io.to(roomId).emit("request_action", {
      type: "tax_event",
      pos: position,
      playerIndex: playerIndex,
      tax: calculatedTax,
      isDouble: isDouble,
    });
  }

  // 위 이벤트에 해당하지 않는 경우에만 턴 종료 처리
  if (isDouble) {
    io.to(roomId).emit("update_state", room.state);
    io.to(roomId).emit("enable_roll_dice", { playerIndex });
  } else {
    nextTurn(roomId);
  }
}

server.listen(3000, () => console.log("🚀 온라인 게임 서버 가동 중 (Port 3000)"));
