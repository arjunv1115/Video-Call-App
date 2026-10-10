import { sql } from "./config/db.js";


// Socket.IO Room State: roomId -> Map<socketId, participantObject>
const rooms = new Map();

export function setupSocketIO(io){
    io.on("connection", (socket)=>{
        let currentRoomId = null;
        let currentUser = null;

        // User Joins a Meeting Room
        socket.on("join-room", async ({roomId, user, audioEnabled = true, videoEnabled = true}) => {
            try {
                // Verify Meeting Status from DB
                const meetings = await sql`SELECT * FROM meetings WHERE meeting_id = ${roomId}`;

                if(meetings.length === 0){
                    socket.emit("meeting-ended", {message: "Meeting not Found."})
                    return;
                }
                const meeting = meetings[0];

                if(meeting.status === "ended"){
                    socket.emit("meeting-ended", {message: "This Meeting has Already Ended."})
                    return;
                }

                currentRoomId = roomId;
                const isHost = meeting.host_id && user?.id && meeting.host_id.toString() === user.id.toString();

                currentUser = {
                    socketId: socket.id,
                    userId: user?.id,
                    userName: user?.name || "Anonymous",
                    isHost,
                    audioEnabled,
                    videoEnabled,
                }

                if(!rooms.has(roomId)){
                    rooms.set(roomId, new Map())
                }

                const roomParticipants = rooms.get(roomId);

                // Fetch Host Plan to Enforce Participant Limits (10 for Free, 100 for Premium)
                const hosts = await sql`SELECT plan FROM users WHERE id = ${meeting.host_id}`;

                const hostPlan = hosts[0]?.plan || "free";
                const maxParticipants = hostPlan === "premium" ? 100 : 10;

                if(roomParticipants.size >= maxParticipants){
                    socket.emit("meeting-ended", {
                        message: `Meeting Capacity Limit Reached (max ${maxParticipants} Participants for ${hostPlan.toUpperCase()} Plan). Host must Upgrade to Premium for up to 100 Participants!`,
                    })
                    return;
                }
                socket.join(roomId);

                // Get Existing Participants in the Room
                const existingUsers = Array.from(roomParticipants.values());

                // Add New Participant to Socket State
                roomParticipants.set(socket.id, currentUser);

                // Save Participant into DB if not already Present
                const userId = user?.id || null;
                const existingParticipants = await sql`
                SELECT id FROM meeting_participants
                WHERE meeting_id = ${meeting.id}
                AND((${userId}::text IS NOT NULL AND user_id = ${userId}) OR name = ${currentUser.userName})`;

                if(existingParticipants.length === 0){
                    await sql`
                    INSERT INTO meeting_participants (meeting_id, user_id, name, joined_at)
                    VALUES (${meeting.id}, ${userId}, ${currentUser.userName}, NOW())
                    `;
                }

                // Send persisted chat history to the participant after membership
                // has been established, so non-host participants can load history
                // without racing the participant INSERT.
                const chatHistory = await sql`
                    SELECT id, sender_id, sender_name, text, timestamp
                    FROM meeting_messages
                    WHERE meeting_id = ${meeting.id}
                    ORDER BY timestamp ASC, id ASC
                `;

                socket.emit("chat-history", chatHistory.map((msg)=>({
                    id: msg.id,
                    roomId,
                    senderId: msg.sender_id,
                    senderName: msg.sender_name,
                    text: msg.text,
                    timestamp: msg.timestamp,
                    time: msg.timestamp
                        ? new Date(msg.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                        })
                        : "",
                })));

                // Send List of Existing Users to the Newcomer
                socket.emit("all-users", existingUsers);

                
                // Notify Everyone Else in the Room
                socket.to(roomId).emit("user-joined", currentUser);

            } catch (err) {
                console.error("Error Joining Room in Socket:", err);
                socket.emit("meeting-ended", { message: "Failed to Join Room." });
            }
        })

        // WebRTC Signaling: Offer
        // Send the Information Needed to Start the Connection
        socket.on('offer', ({targetSocketId, callerSocketId, sdp})=>{
            io.to(targetSocketId).emit("offer", {
                callerSocketId,
                sdp,
                callerUser: currentUser,
            })
        })

        // WebRTC Signaling: Answer
        // Accept the Offer Request and Process the Connection
        socket.on('answer', ({targetSocketId, responderSocketId, sdp})=>{
            io.to(targetSocketId).emit("answer", {
                responderSocketId,
                sdp,
            })
        })

        // WebRTC Signaling: ICE Caandidate
        // Passes the Connection Details from One User to the Other so WebRTC can Figure out how to Connect them Directly.
        socket.on('ice-candidate', ({ targetSocketId, senderSocketId, candidate })=>{
            io.to(targetSocketId).emit("ice-candidate", {
                senderSocketId,
                candidate,
            })
        })

        // Audio Toggle Event
        socket.on('toggle-audio', ({ roomId, audioEnabled })=>{
            if(rooms.has(roomId) && rooms.get(roomId).has(socket.id)){
                rooms.get(roomId).get(socket.id).audioEnabled = audioEnabled;
            }
            socket.to(roomId).emit("user-toggled-audio", {
                socketId: socket.id,
                audioEnabled,
            })
        })

        // Video Toggle Event
        socket.on('toggle-video', ({ roomId, videoEnabled })=>{
            if(rooms.has(roomId) && rooms.get(roomId).has(socket.id)){
                rooms.get(roomId).get(socket.id).videoEnabled = videoEnabled;
            }
            socket.to(roomId).emit("user-toggled-video", {
                socketId: socket.id,
                videoEnabled,
            })
        })

        // Chat Message Event -> Persist to DB & Broadcast
        socket.on("send-message", async ({roomId, message}, acknowledge) => {
            try {
                if(!roomId || !message?.text?.trim()){
                    acknowledge?.({ok: false, error: "Message cannot be empty"});
                    return;
                }

                const meetings = await sql`
                    SELECT id, status
                    FROM meetings
                    WHERE meeting_id = ${roomId}
                    LIMIT 1
                `;

                if(meetings.length === 0){
                    acknowledge?.({ok: false, error: "Meeting not found"});
                    return;
                }

                const meeting = meetings[0];

                if(meeting.status === "ended"){
                    acknowledge?.({ok: false, error: "This meeting has ended"});
                    return;
                }

                // The sender is taken from the authenticated/registered socket
                // participant instead of trusting a client-supplied sender ID.
                const senderId = currentUser?.userId || message.senderId || null;
                const senderName = currentUser?.userName || message.senderName || "Anonymous";
                const text = message.text.trim();

                // Ensure the socket is actually in this meeting before writing.
                if(currentRoomId !== roomId || !currentUser){
                    acknowledge?.({ok: false, error: "You are not connected to this meeting"});
                    return;
                }

                const [savedMessage] = await sql`
                    INSERT INTO meeting_messages
                        (meeting_id, sender_id, sender_name, text, timestamp)
                    VALUES
                        (${meeting.id}, ${senderId}, ${senderName}, ${text}, NOW())
                    RETURNING id, sender_id, sender_name, text, timestamp
                `;

                const chatMessage = {
                    id: savedMessage.id,
                    roomId,
                    senderId: savedMessage.sender_id,
                    senderName: savedMessage.sender_name,
                    text: savedMessage.text,
                    timestamp: savedMessage.timestamp,
                    time: new Date(savedMessage.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                    }),
                    senderSocketId: socket.id,
                };

                io.in(roomId).emit("receive-message", chatMessage);
                acknowledge?.({ok: true, message: chatMessage});
            } catch (err) {
                console.error("Error Saving Chat Message to DB:", err);
                acknowledge?.({ok: false, error: "Failed to save chat message"});
            }
        })

        // Host Explicitly Ends Meeting for all via End Meeting Button

        socket.on('end-meeting', async ({ roomId })=>{
            try {
               await sql`
                  UPDATE meetings
                  SET status = 'ended', ended_at = NOW()
                  WHERE meeting_id = ${roomId}`;

                  io.to(roomId).emit("meeting-ended", { message: "The Meeting has been Ended by the Host." });
                  rooms.delete(roomId);
            } catch (err) {
                console.error("Error Ending Meeting:", err);
            }
        })

        // Handle Disconnect (Reloading Window, Network Drop or Closing Tab)
        socket.on('disconnect', ()=>{
            if (currentRoomId && rooms.has(currentRoomId)) {
                const roomParticipants = rooms.get(currentRoomId);
                roomParticipants.delete(socket.id);

                if(roomParticipants.size === 0){
                    rooms.delete(currentRoomId);
                } else {
                    // Notify Remaining Peers that a User Disconnected
                    socket.to(currentRoomId).emit("user-left", {
                        socketId: socket.id,
                        user: currentUser,
                    })
                }
            }
        })

    })
}