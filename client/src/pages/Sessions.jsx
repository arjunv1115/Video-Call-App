import { ArrowLeftIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import EmptySessions from '../components/sessions/EmptySessions'
import SessionCard from '../components/sessions/SessionCard'
import SessionDetailModal from '../components/sessions/SessionDetailModal'
import {toast} from "react-hot-toast"
import { useAuth } from '@clerk/react'
import api from '../config/api.js'
import Loader from '../components/Loader.jsx'

const Sessions = () => {

  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);

  const {isLoaded, isSignedIn, getToken} = useAuth();

  useEffect(()=>{
    const fetchSessions = async () => {
      if(!isLoaded || !isSignedIn) return;

      try {
        const token = await getToken();
        if(!token) return;
        const res = await api("/api/meetings/sessions", {headers: {Authorization: `Bearer ${token}`}})
        setSessions(res.data.meetings || []);
      } catch (_error) {
        toast.error("Failed to Load Meeting Sessions");
      } finally {
        setLoading(false);
      }
    }
    fetchSessions();

  },[isLoaded, isSignedIn, getToken])

  const openSessionDetails = async (meetingId)=>{
    if(!meetingId) {
      toast.error("Meeting ID is missing");
      return;
    }

    try {
      const token = await getToken();

      if(!token) {
        toast.error("Authentication token is unavailable");
        return;
      }

      const res = await api.get(`/api/meetings/sessions/${encodeURIComponent(meetingId)}`, {
        headers: {Authorization: `Bearer ${token}`}
      });

      if(res.data?.meeting) {
        setSelectedSession(res.data.meeting);
      } else {
        throw new Error("Meeting details were not returned by the server");
      }
    } catch (error) {
      console.error("Fetch Session Details Failed:", error);
      toast.error(error.response?.data?.error || "Failed to fetch session details");
    }
  }

  if(loading){
    return <Loader text="Loading Meeting History..."/>
  }

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-12">
      {/* Page Titlle & Navigation Header */}
      <Link to="/dashboard" className="flex items-center text-sm gap-1 mb-4 text-slate-500 hover:text-slate-900 transition-colors">
        <ArrowLeftIcon size={14}/> Go to Dashboard
      </Link>
      <div className="mb-8">
        <h1 className="text-3xl font-medium tracking-tight text-slate-900">Meeting Sessions.</h1>
        <p className="text-sm text-slate-500 mt-1">Review your Past and Active Meeting History, Participant Logs and Chat Transcripts.</p>
      </div>

      {/* Sessions Grid / Empty State */}
    {
      sessions.length === 0 ? (
        <EmptySessions />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sessions.map((session)=>(
            <SessionCard 
            key={session.id}
            session={session}
            onOpenDetails={openSessionDetails}
            onRejoin={(meetingId)=>navigate(`/meeting/${meetingId}`)}/>
          ))}
        </div>
      )
    }


    {/* Session Detail Modal */}
    <SessionDetailModal session={selectedSession} onClose={()=> setSelectedSession(null)}/>

    </main>
  )
}

export default Sessions