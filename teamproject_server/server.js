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
// undefined 값이 있어도 에러를 내지 않고 무시하도록 설정
db.settings({ ignoreUndefinedProperties: true });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  allowEIO3: true,
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
      const key = doc.id; // 이미 user1, user2 형식
      users[key] = doc.data();
    });
    return users;
  } catch (e) {
    return null;
  }
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

  let safety = 0;
  while (room.state.users[`user${nextPlayerIndex}`]?.type === "D" && safety < activeIndexes.length) {
    nextIndexInList = (nextIndexInList + 1) % activeIndexes.length;
    nextPlayerIndex = activeIndexes[nextIndexInList];
    safety++;
  }

  room.state.currentTurn = nextPlayerIndex;
  const nextPlayer = room.state.users[`user${nextPlayerIndex}`];

  console.log(`🎲 [턴 교체] Player ${room.state.currentTurn} 차례`);

  // ✅ [추가] 다음 플레이어가 무인도에 갇힌 상태라면 즉시 팝업 요청을 보냄
  if (nextPlayer && nextPlayer.islandCount > 0) {
    console.log(`🏝 Player ${nextPlayerIndex} 무인도 상태 확인 - 팝업 요청`);
    io.to(roomId).emit("request_action", {
      type: "island_event",
      pos: 7,
      playerIndex: nextPlayerIndex,
      islandCount: nextPlayer.islandCount,
    });
  }

  io.to(roomId).emit("update_state", room.state);
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

        await roomRef.set({
          localName: localData?.localName || "알 수 없음",
          localCode: localData?.localCode || "",
          status: "waiting",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          board: initialBoard,
        });

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
            name: "대기중...",
            money: DEFAULT_MONEY,
            totalMoney: DEFAULT_MONEY,
            position: 0,
            islandCount: 0,
            level: 1,
            card: "N",
          }),
          usersCol.doc("user3").set({
            type: "N",
            name: "대기중...",
            money: DEFAULT_MONEY,
            totalMoney: DEFAULT_MONEY,
            position: 0,
            islandCount: 0,
            level: 1,
            card: "N",
          }),
          usersCol.doc("user4").set({
            type: "N",
            name: "대기중...",
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
                name: "대기중...",
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                type: "N",
                islandCount: 0,
                level: 1,
              },
              user3: {
                name: "대기중...",
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                type: "N",
                islandCount: 0,
                level: 1,
              },
              user4: {
                name: "대기중...",
                money: DEFAULT_MONEY,
                totalMoney: DEFAULT_MONEY,
                position: 0,
                type: "N",
                islandCount: 0,
                level: 1,
              },
            },
            board: initialBoard,
            currentTurn: 1,
            totalTurn: 20,
            localName: localData?.localName || "",
          },
          players: [],
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

  socket.on("get_rooms", () => {
    socket.emit("room_list", Object.keys(rooms));
  });

  socket.on("join_room", (roomId) => {
    roomId = String(roomId);
    if (rooms[roomId]) {
      socket.emit("join_success", roomId);
    } else {
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
      try {
        const roomRef = db.collection("online").doc(roomId);
        const roomSnap = await roomRef.get();
        if (roomSnap.exists) {
          const dbUsers = await getPlayersFromDB(roomId);
          rooms[roomId] = {
            state: { ...roomSnap.data(), users: dbUsers || {} },
            players: rooms[roomId]?.players || [],
          };
        }
      } catch (e) {
        console.error("❌ 데이터 로드 오류:", e);
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
      const userKey = `user${idx}`;
      if (room.state.users[userKey]) {
        room.state.users[userKey].type = "P";
        room.state.users[userKey].name = `Player ${idx}`;
        room.state.users[userKey].id = socket.id;

        db.collection("online")
          .doc(roomId)
          .collection("users")
          .doc(`user${idx}`)
          .update({ type: "P", name: `Player ${idx}`, id: socket.id });
      }
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
    const steps = d1 + d2;
    const isDouble = d1 === d2;

    io.to(roomId).emit("dice_animation", { playerIndex: player.index, d1, d2, isDouble });

    // setTimeout(async () => {
    //   const user = room.state.users[`user${player.index}`];
    //   if (!user) return;

    //   // 🏝️ 무인도 탈출 체크 로직
    //   if (user.islandCount > 0) {
    //     if (isDouble) {
    //       user.islandCount = 0; // 더블이면 즉시 탈출 후 주사위만큼 이동 진행
    //       console.log(`🎲 Player ${player.index} 더블로 무인도 탈출!`);
    //     } else {
    //       user.islandCount -= 1; // 카운트만 감소
    //       console.log(`🏝️ Player ${player.index} 무인도 대기 중... 남은 턴: ${user.islandCount}`);

    //       await db.collection("online").doc(roomId).collection("users").doc(`user${player.index}`).update({
    //         islandCount: user.islandCount,
    //       });
    //       return nextTurn(roomId);
    //     }
    //   }

    // const oldPos = user.position || 0;
    // user.position = (oldPos + d1 + d2) % 28;
    //   // user.position = 3;
    //   // 🏝️ 무인도 도착 시 처리
    //   if (user.position === 7) {
    //     user.islandCount = 3;
    //     // DB 업데이트만 하고 턴을 종료합니다. (팝업 요청 삭제)
    //     await db.collection("online").doc(roomId).collection("users").doc(`user${player.index}`).update({
    //       position: user.position,
    //       islandCount: user.islandCount,
    //     });

    //     io.to(roomId).emit("update_state", room.state);

    //     // 도착한 즉시 팝업을 띄우지 않고 턴을 넘깁니다.
    //     return nextTurn(roomId);
    //   }

    //   if (oldPos + d1 + d2 >= 28) {
    //     user.money += 1000000;
    //     user.totalMoney = (user.totalMoney || 0) + 1000000;
    //     if ((user.level || 1) < 4) user.level = (user.level || 1) + 1;
    //   }

    //   io.to(roomId).emit("update_state", room.state);

    //   db.collection("online")
    //     .doc(roomId)
    //     .collection("users")
    //     .doc(`user${player.index}`)
    //     .update({
    //       position: user.position,
    //       money: user.money,
    //       totalMoney: user.totalMoney,
    //       level: user.level,
    //       islandCount: user.islandCount,
    //     })
    //     .catch((e) => console.error("DB 업데이트 오류:", e));

    //   const tile = room.state.board[`b${user.position}`] || { type: "none" };

    //   setTimeout(() => {
    //     if (tile.type === "land") {
    //       const noOwner = !tile.owner || tile.owner === "N" || tile.owner === "0" || tile.owner === 0;
    //       const isMyProperty = !noOwner && tile.owner.toString() === player.index.toString();

    //       if (noOwner || isMyProperty) {
    //         io.to(roomId).emit("request_action", {
    //           type: "land_event",
    //           pos: user.position,
    //           playerIndex: player.index,
    //           isDouble,
    //         });
    //         return;
    //       } else {
    //         let levelMulti = [0, 2, 6, 14, 30][tile.level || 0];
    //         let toll = tile.tollPrice * (tile.multiply || 1) * levelMulti;
    //         io.to(roomId).emit("request_action", {
    //           type: "toll_event",
    //           pos: user.position,
    //           playerIndex: player.index,
    //           toll,
    //           ownerIndex: tile.owner,
    //           isDouble,
    //         });
    //         return;
    //       }
    //     }

    //     if (tile.type === "tax") {
    //       io.to(roomId).emit("request_action", {
    //         type: "tax_event",
    //         pos: user.position,
    //         playerIndex: player.index,
    //         tax: 500000,
    //         isDouble,
    //       });
    //       return;
    //     }
    //     if (tile.type === "chance") {
    //       console.log(`🎲 찬스 타일 감지: Player ${player.index}`);
    //       io.to(roomId).emit("request_action", {
    //         type: "chance", // 클라이언트의 _handleServerRequest에서 기다리는 문자열
    //         pos: user.position,
    //         playerIndex: player.index,
    //         isDouble: isDouble,
    //       });
    //       return; // 클라이언트의 응답(action_complete)을 기다려야 하므로 여기서 멈춤
    //     }

    //     if (isDouble) {
    //       console.log(`🎲 더블 발생! Player ${player.index} 한 번 더 던지세요.`);
    //       io.to(roomId).emit("update_state", room.state);
    //     } else {
    //       nextTurn(roomId);
    //     }
    //   }, 800);
    // }, 2200);
    setTimeout(async () => {
      const user = room.state.users[`user${player.index}`];
      if (!user) return;

      const oldPos = user.position || 0;
      user.position = (oldPos + d1 + d2) % 28;

      // 🏝️ [활성화] 무인도 탈출 체크 로직
      if (user.islandCount > 0) {
        if (isDouble) {
          user.islandCount = 0;
          console.log(`🎲 Player ${player.index} 더블로 무인도 탈출!`);
          // 더블 탈출 시에는 이동을 진행합니다.
        } else {
          user.islandCount -= 1;
          console.log(`🏝️ Player ${player.index} 무인도 대기 중... 남은 턴: ${user.islandCount}`);

          await updateDBUser(roomId, player.index, user);
          io.to(roomId).emit("update_state", room.state);
          return nextTurn(roomId); // 이동 없이 턴 종료
        }
      }

      // 2. 무인도가 아니거나 탈출 성공 시, 말 이동 애니메이션 지시
      io.to(roomId).emit("move_player", {
        playerIndex: player.index,
        steps: steps,
        isDouble: isDouble, // 더블 여부 전달
      });
    }, 2200); // 주사위 굴러가는 시간 대기
  });

  socket.on("move_complete", async ({ roomId, playerIndex, finalPos, isDouble }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.state.users[`user${playerIndex}`];
    const oldPos = user.position || 0;
    user.position = finalPos; // 클라이언트가 보고한 위치로 확정

    const passedStart = finalPos < oldPos;

    if (passedStart) {
      console.log(`💰 Player ${playerIndex} 시작점 통과! 레벨업 시도.`);
      user.money += 1000000;
      user.totalMoney += 1000000;

      // 레벨 초기값이 없을 경우를 대비해 1로 시작
      if (!user.level) user.level = 1;

      if (user.level < 4) {
        user.level += 1;
        console.log(`⬆️ 레벨 상승: ${user.level - 1} -> ${user.level}`);
      }
    }

    // 🏝️ 무인도 도착 시 처리
    if (user.position === 7) {
      user.islandCount = 3;
      await updateDBUser(roomId, playerIndex, user);
      io.to(roomId).emit("update_state", room.state);
      return nextTurn(roomId);
    }

    // DB 업데이트
    await updateDBUser(roomId, playerIndex, user);
    io.to(roomId).emit("update_state", room.state);

    // 🚩 도착한 타일의 이벤트 판정
    const tile = room.state.board[`b${user.position}`] || { type: "none" };
    // db.collection("online")
    //   .doc(roomId)
    //   .collection("users")
    //   .doc(`user${player.index}`)
    //   .update({
    //     position: user.position,
    //     money: user.money,
    //     totalMoney: user.totalMoney,
    //     level: user.level,
    //     islandCount: user.islandCount,
    //   })
    //   .catch((e) => console.error("DB 업데이트 오류:", e));

    if (tile.type === "start") {
      // 💡 출발지에 딱 멈췄을 때 팝업을 띄우기 위한 요청
      io.to(roomId).emit("request_action", {
        type: "start_event",
        playerIndex,
      });
    } else if (tile.type === "festival") {
      // 💡 축제 칸에 멈췄을 때
      io.to(roomId).emit("request_action", {
        type: "festival_event",
        pos: user.position,
        playerIndex,
      });
    }

    // (이 아래는 기존 roll_dice에 있던 land, toll, tax, chance 판정 로직을 그대로 사용합니다)
    if (tile.type === "land") {
      const noOwner = !tile.owner || tile.owner === "N" || tile.owner === "0" || tile.owner === 0;
      const isMyProperty = !noOwner && tile.owner.toString() === playerIndex.toString();

      if (noOwner || isMyProperty) {
        io.to(roomId).emit("request_action", {
          type: "land_event",
          pos: user.position,
          playerIndex: playerIndex,
          isDouble,
        });
        return;
      } else if (isMyProperty && user.level <= tile.level) {
        return;
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
        return;
      }
    } else if (tile.type === "tax") {
      const userKey = `user${playerIndex}`;
      const roomState = room.state;

      let totalBuildingValue = 0;

      // 💡 레벨별 건설 비용 가중치 정의 (0레벨: 0, 1레벨: 1, 2레벨: 3, 3레벨: 7, 4레벨: 15)
      const levelMultipliers = [0, 1, 3, 7, 15];

      // 보드판 전체를 순회하며 해당 유저의 건물 가치 합산
      for (let key in roomState.board) {
        const boardTile = roomState.board[key];

        // 1. 내 땅인지 확인
        if (boardTile.owner?.toString() === playerIndex.toString()) {
          const currentLevel = boardTile.level || 0;
          const basePrice = boardTile.tollPrice || 0; // 건물마다 다른 기본 건설 비용

          // 2. 가중치 적용: (기본 비용 * 레벨별 배수)
          // 예: 2레벨 건물이면 기본비용의 3배를 가치로 산정
          if (currentLevel > 0) {
            totalBuildingValue += basePrice * levelMultipliers[currentLevel];
          }
        }
      }

      // 3. 최종 세금 산출 (총 가치의 10%)
      const calculatedTax = Math.floor(totalBuildingValue * 0.1);

      console.log(`💰 [국세청] Player ${playerIndex} 세금 계산`);
      console.log(`- 총 건물 가치: ${totalBuildingValue}원`);
      console.log(`- 부과 세금(10%): ${calculatedTax}원`);

      // 4. 클라이언트에 세금 액수 전달
      io.to(roomId).emit("request_action", {
        type: "tax_event",
        pos: roomState.users[userKey].position,
        playerIndex: playerIndex,
        tax: calculatedTax,
        isDouble: isDouble,
      });
      return;
    } else if (tile.type === "chance") {
      io.to(roomId).emit("request_action", { type: "chance", pos: user.position, playerIndex });
    } else if (tile.type === "festival") {
      // 💡 축제 타일 도착 시 클라이언트에 축제 열 땅을 고르라고 요청
      io.to(roomId).emit("request_action", {
        type: "festival_event",
        pos: user.position,
        playerIndex,
      });
    } else if (tile.type === "travel") {
      // 💡 국내여행(21번) 분기 추가
      io.to(roomId).emit("request_action", {
        type: "travel_event", // 클라이언트에 보낼 타입
        pos: user.position,
        playerIndex,
      });
    } else {
      // 아무 이벤트 없는 칸
      nextTurn(roomId);
    }
  });

  // 중복 코드를 줄이기 위한 유틸 함수
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

  // ✅ [추가] 무인도 주사위 던지기 대기 완료 이벤트
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
            if (stateUpdate.users[uKey].islandCount === 0 && room.state.users[uKey].islandCount > 0) {
              isIslandEscape = true;
            }

            const userDocId = uKey;
            const userSnap = await roomRef.collection("users").doc(userDocId).get();
            let currentDbData = userSnap.exists ? userSnap.data() : room.state.users[uKey];
            stateUpdate.users[uKey].card;
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

      console.log(`✅ [액션 완료] 방: ${roomId}, 다음 처리 진행`);
      if (isIslandEscape) {
        console.log("🏝️ 무인도 탈출 성공! 턴을 유지하고 주사위 권한을 부여합니다.");
        io.to(roomId).emit("update_state", room.state);
        // 여기서 nextTurn()을 호출하지 않으므로 주사위 버튼이 활성화된 상태 유지
      } else if (isDouble) {
        io.to(roomId).emit("update_state", room.state);
      } else {
        nextTurn(roomId);
      }
    } catch (e) {
      console.error("❌ 액션 완료 처리 오류:", e);
    }
  });

  socket.on("sell_assets", async ({ roomId, playerIndex, sellKeys, totalEarned }) => {
    const room = rooms[roomId];
    if (!room) return;
    try {
      const roomRef = db.collection("online").doc(roomId);
      const userKey = `user${playerIndex}`;
      const userDocId = `user${playerIndex}`;

      let bUpdates = {};
      sellKeys.forEach((key) => {
        if (room.state.board[key]) {
          room.state.board[key].owner = "N";
          room.state.board[key].level = 0;
          room.state.board[key].isFestival = false;
        }
        bUpdates[`board.${key}.owner`] = "N";
        bUpdates[`board.${key}.level`] = 0;
        bUpdates[`board.${key}.isFestival`] = false;
      });

      if (Object.keys(bUpdates).length > 0) await roomRef.update(bUpdates);
      const user = room.state.users[userKey];
      user.money += totalEarned;
      await roomRef.collection("users").doc(userDocId).update({ money: user.money });

      console.log(`💰 [자산 매각] Player ${playerIndex} 완료`);
      io.to(roomId).emit("update_state", room.state);
    } catch (e) {
      console.error("❌ 자산 매각 오류:", e);
    }
  });

  socket.on("player_bankrupt", async ({ roomId, playerIndex }) => {
    const room = rooms[roomId];
    if (!room) return;
    try {
      const roomRef = db.collection("online").doc(roomId);
      const userKey = `user${playerIndex}`;
      const userDocId = `user${playerIndex}`;

      if (room.state.users[userKey]) {
        room.state.users[userKey].type = "D";
        room.state.users[userKey].money = 0;
        room.state.users[userKey].totalMoney = 0;
      }
      await roomRef.collection("users").doc(userDocId).update({ type: "D", money: 0 });

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
    } catch (e) {
      console.error("❌ 파산 처리 오류:", e);
    }
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
