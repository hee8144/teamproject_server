const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let rooms = {};

// 서버 시작 시 DB 동기화
async function syncRooms() {
    const snapshot = await db.collection("online").get();
    for (const doc of snapshot.docs) {
        const usersSnap = await doc.ref.collection("users").where("type", "==", "P").get();
        const players = usersSnap.docs.map(u => u.data().id).filter(id => id);
        if (players.length > 0) rooms[doc.id] = { players };
        else {
            // 유령방 삭제
            const uDocs = await doc.ref.collection("users").get();
            const batch = db.batch();
            uDocs.forEach(d => batch.delete(d.ref));
            batch.delete(doc.ref);
            await batch.commit();
        }
    }
    io.emit("room_list", rooms);
}
syncRooms();

io.on("connection", (socket) => {
    socket.on("create_room", (roomId) => {
        rooms[roomId] = { players: [socket.id] };
        socket.join(roomId);
        socket.emit("join_success", roomId);
        io.emit("room_list", rooms);
    });

    socket.on("join_room", (roomId) => {
        if (!rooms[roomId]) return socket.emit("join_failed", "방이 없습니다.");
        if (!rooms[roomId].players.includes(socket.id)) rooms[roomId].players.push(socket.id);
        socket.join(roomId);
        socket.emit("join_success", roomId);
        io.emit("room_list", rooms);
    });

    socket.on("disconnect", async () => {
        for (const roomId of Object.keys(rooms)) {
            if (rooms[roomId].players.includes(socket.id)) {
                rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
                const roomRef = db.collection("online").doc(roomId);

                if (rooms[roomId].players.length === 0) {
                    delete rooms[roomId];
                    const uDocs = await roomRef.collection("users").get();
                    const batch = db.batch();
                    uDocs.forEach(d => batch.delete(d.ref));
                    batch.delete(roomRef);
                    await batch.commit();
                    console.log(`방 삭제 완료: ${roomId}`);
                } else {
                    const snap = await roomRef.collection("users").where("id", "==", socket.id).get();
                    if (!snap.empty) {
                        const batch = db.batch();
                        snap.forEach(d => batch.update(d.ref, { type: "N", id: admin.firestore.FieldValue.delete() }));
                        await batch.commit();
                    }
                }
            }
        }
        io.emit("room_list", rooms);
    });
});

server.listen(3000, () => console.log("서버 3000 포트 실행 중"));