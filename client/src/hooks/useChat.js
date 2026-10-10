import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "../config/socket";
import api from "../config/api";

export const useChat = (roomId, user, getToken)=>{
    const [messages, setMessages] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isChatOpen, setIsChatOpen] = useState(false);

    const isChatOpenRef = useRef(isChatOpen);

    useEffect(()=>{
        isChatOpenRef.current = isChatOpen;
    }, [isChatOpen]);

    // Load messages that were already saved for this meeting.
    useEffect(()=>{
        if(!roomId || !user?.id) return;

        let cancelled = false;

        const fetchMessages = async ()=>{
            try {
                const token = await getToken?.();

                const response = await api.get(
                    `/api/meetings/${encodeURIComponent(roomId)}/messages`,
                    token
                        ? {headers: {Authorization: `Bearer ${token}`}}
                        : undefined
                );

                if(!cancelled){
                    const history = response.data?.messages || [];
                    setMessages((prev)=>{
                        const combined = [...prev, ...history];
                        const unique = new Map();

                        combined.forEach((item)=>{
                            const key = item?.id != null
                                ? String(item.id)
                                : `${item?.senderId || ""}-${item?.timestamp || ""}-${item?.text || ""}`;
                            if(!unique.has(key)) unique.set(key, item);
                        });

                        return Array.from(unique.values()).sort(
                            (a, b)=>new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
                        );
                    });
                }
            } catch (error) {
                if(!cancelled){
                    console.error("Failed to fetch meeting chat messages:", error);
                }
            }
        };

        fetchMessages();

        return ()=>{
            cancelled = true;
        };
    }, [roomId, user?.id, getToken]);

    // Receive only messages belonging to this meeting.
    useEffect(()=>{
        if(!roomId) return;

        const mergeMessages = (incoming)=>{
            setMessages((prev)=>{
                const combined = [...prev, ...(Array.isArray(incoming) ? incoming : [incoming])];
                const unique = new Map();

                combined.forEach((item)=>{
                    const key = item?.id != null
                        ? String(item.id)
                        : `${item?.senderId || ""}-${item?.timestamp || ""}-${item?.text || ""}`;

                    if(!unique.has(key)){
                        unique.set(key, item);
                    }
                });

                return Array.from(unique.values()).sort((a, b)=>{
                    const first = new Date(a.timestamp || 0).getTime();
                    const second = new Date(b.timestamp || 0).getTime();
                    return first - second;
                });
            });
        };

        const handleChatHistory = (history)=>{
            const roomMessages = (history || []).filter(
                (message)=>!message.roomId || message.roomId === roomId
            );
            mergeMessages(roomMessages);
        };

        const handleReceiveMessage = (message)=>{
            if(message?.roomId && message.roomId !== roomId) return;

            mergeMessages(message);

            if(!isChatOpenRef.current){
                setUnreadCount((prev) => prev + 1);
            }
        };

        socket.on("chat-history", handleChatHistory);
        socket.on("receive-message", handleReceiveMessage);

        return ()=>{
            socket.off("chat-history", handleChatHistory);
            socket.off("receive-message", handleReceiveMessage);
        };
    }, [roomId]);

    const sendMessage = useCallback(
        (text)=>{
            const trimmedText = text?.trim();

            if(!trimmedText || !user?.id || !roomId) return;

            socket.emit("send-message", {
                roomId,
                message: {
                    text: trimmedText,
                    senderId: user.id,
                    senderName: user.name || user.fullName || "You",
                }
            });
        },
        [roomId, user?.id, user?.name, user?.fullName]
    );

    const toggleChat = useCallback(()=>{
        setIsChatOpen((prev)=>{
            if(!prev) setUnreadCount(0);
            return !prev;
        });
    }, []);

    return {
        messages,
        sendMessage,
        unreadCount,
        isChatOpen,
        toggleChat
    };
};
