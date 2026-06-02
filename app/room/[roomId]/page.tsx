'use client';

import { useEffect, useState, useRef, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, PhoneOff,
  Settings, Maximize, Copy, Users, X
} from 'lucide-react';
import type Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';

/* ========== DUMMY TRACK GENERATOR ========== */
const createDummyVideoTrack = (): MediaStreamTrack => {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0a0a1a'; // fondo oscuro
    ctx.fillRect(0, 0, 1, 1);
  }
  return canvas.captureStream(1).getVideoTracks()[0];
};

/* ========== AUDIO VOLUME HOOK ========== */
function useAudioVolume(stream: MediaStream | null) {
  const [isSpeaking, setIsSpeaking] = useState(false);

  useEffect(() => {
    if (!stream) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    let audioContext: AudioContext | null = null;
    let animationFrame: number;
    let source: MediaStreamAudioSourceNode | null = null;

    try {
      audioContext = new window.AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;

      source = audioContext.createMediaStreamSource(new MediaStream([audioTracks[0]]));
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkVolume = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const average = sum / dataArray.length;
        setIsSpeaking(average > 12);
        animationFrame = requestAnimationFrame(checkVolume);
      };

      const resume = () => {
        if (audioContext && audioContext.state === 'suspended') audioContext.resume();
      };
      window.addEventListener('click', resume);
      window.addEventListener('touchstart', resume);

      checkVolume();

      return () => {
        window.removeEventListener('click', resume);
        window.removeEventListener('touchstart', resume);
        cancelAnimationFrame(animationFrame);
        if (source) source.disconnect();
        if (audioContext && audioContext.state !== 'closed') audioContext.close();
      };
    } catch {
      // ignore
    }
  }, [stream]);

  return isSpeaking;
}

/* ========== RESOLUTION / FPS CONFIG ========== */
const RESOLUTIONS = [
  { label: '480p', w: 854, h: 480 },
  { label: '720p', w: 1280, h: 720 },
  { label: '1080p', w: 1920, h: 1080 },
  { label: '1440p', w: 2560, h: 1440 },
  { label: '4K', w: 3840, h: 2160 },
];

const FPS_OPTIONS = [30, 60, 120];

/* ========== MAIN ROOM COMPONENT ========== */
export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const router = useRouter();

  const [nickname, setNickname] = useState('');
  
  // Streams locales
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  // Estados visuales
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState('');

  // Dispositivos y Calidad
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);

  const [selectedMic, setSelectedMic] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const [selectedCamera, setSelectedCamera] = useState('');

  const [selectedRes, setSelectedRes] = useState(2); // 1080p
  const [selectedFps, setSelectedFps] = useState(60); // 60fps

  // Remotos
  const [remoteStreams, setRemoteStreams] = useState<Record<string, { stream: MediaStream; nickname: string }>>({});

  // Referencias mutables
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localContainerRef = useRef<HTMLDivElement>(null);
  const callsRef = useRef<Record<string, MediaConnection>>({});
  const heartbeatRef = useRef<NodeJS.Timeout>(null);
  const peerRef = useRef<Peer | null>(null);
  const initRef = useRef(false);

  // Tracks activos locales para WebRTC
  const currentVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const dummyTrackRef = useRef<MediaStreamTrack | null>(null);

  const isSpeaking = useAudioVolume(localStream);

  /* ---- Show Toast ---- */
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  }, []);

  /* ---- Devices ---- */
  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter(d => d.kind === 'audioinput'));
      setAudioOutputs(devices.filter(d => d.kind === 'audiooutput'));
      setVideoInputs(devices.filter(d => d.kind === 'videoinput'));
    } catch (err) {
      console.warn('Could not enumerate devices', err);
    }
  }, []);

  /* ---- Init System ---- */
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    let currentPeer: Peer;
    const storedNickname = localStorage.getItem('nickname') || 'Invitado';
    setNickname(storedNickname);

    const init = async () => {
      let stream: MediaStream;
      try {
        // Pedimos solo audio inicialmente
        stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      } catch {
        alert('Se necesita permiso de micrófono para continuar.');
        return;
      }

      // Creamos un track de video oscuro "dummy" para que WebRTC negocie video desde el inicio
      const dummyTrack = createDummyVideoTrack();
      dummyTrackRef.current = dummyTrack;
      stream.addTrack(dummyTrack);
      currentVideoTrackRef.current = dummyTrack;

      setLocalStream(stream);

      await enumerateDevices();

      const PeerJS = (await import('peerjs')).default;
      currentPeer = new PeerJS();
      peerRef.current = currentPeer;

      currentPeer.on('open', (id) => {
        const updatePresence = async () => {
          try {
            const res = await fetch(`/api/room/${roomId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ peerId: id, nickname: storedNickname }),
            });
            const data = await res.json();

            data.peers.forEach((p: any) => {
              if (p.peerId !== id && !callsRef.current[p.peerId]) {
                const call = currentPeer.call(p.peerId, stream, {
                  metadata: { nickname: storedNickname },
                });
                handleCall(call);
              }
            });
          } catch (e) {
            console.error('Presence error', e);
          }
        };

        updatePresence();
        heartbeatRef.current = setInterval(updatePresence, 5000);
      });

      currentPeer.on('call', (call) => {
        call.answer(stream);
        handleCall(call);
      });
    };

    init();

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (peerRef.current) {
        if (peerRef.current.id) {
          fetch(`/api/room/${roomId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({ peerId: peerRef.current.id }),
          });
        }
        peerRef.current.destroy();
      }
    };
  }, [roomId, enumerateDevices]);

  /* ---- Handlers ---- */
  const handleCall = (call: MediaConnection) => {
    callsRef.current[call.peer] = call;

    call.on('stream', (remoteStream) => {
      setRemoteStreams((prev) => ({
        ...prev,
        [call.peer]: { stream: remoteStream, nickname: call.metadata?.nickname || 'Usuario' },
      }));
    });

    call.on('close', () => {
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[call.peer];
        return next;
      });
      delete callsRef.current[call.peer];
    });

    call.on('error', () => call.close());
  };

  /* ---- Replace Track Helper ---- */
  const replaceVideoTrackGlobally = (newTrack: MediaStreamTrack) => {
    currentVideoTrackRef.current = newTrack;
    
    // 1. Reemplazar en el stream local
    if (localStream) {
      localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
      localStream.addTrack(newTrack);
    }
    
    // 2. Reemplazar en todas las conexiones PeerJS
    Object.values(callsRef.current).forEach((call) => {
      const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        sender.replaceTrack(newTrack).catch(err => console.warn('replaceTrack failed:', err));
      }
    });
  };

  /* ---- Botones de Control ---- */
  const toggleMute = () => {
    if (!localStream) return;
    const tracks = localStream.getAudioTracks();
    if (tracks.length > 0) {
      tracks[0].enabled = !tracks[0].enabled;
      setIsMuted(!tracks[0].enabled);
    }
  };

  const toggleVideo = async () => {
    if (!localStream) return;

    if (isVideoOn) {
      // APAGAR CÁMARA -> Restaurar el dummy
      if (cameraTrackRef.current) {
        cameraTrackRef.current.stop();
        cameraTrackRef.current = null;
      }
      setIsVideoOn(false);
      
      if (!screenStream && dummyTrackRef.current) {
        replaceVideoTrackGlobally(dummyTrackRef.current);
      }
    } else {
      // ENCENDER CÁMARA
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: selectedCamera ? { deviceId: { exact: selectedCamera } } : true,
        });
        const videoTrack = camStream.getVideoTracks()[0];
        cameraTrackRef.current = videoTrack;
        setIsVideoOn(true);

        if (!screenStream) {
          replaceVideoTrackGlobally(videoTrack);
          // Asegurar que el tag de video local se entere del cambio (por si era un dummy stream sin imagen)
          if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
        }
      } catch (err) {
        console.error('Error al encender cámara', err);
        showToast('No se pudo activar la cámara');
      }
    }
  };

  const toggleScreenShare = async () => {
    if (screenStream) {
      // APAGAR SCREEN SHARE
      screenStream.getTracks().forEach(t => t.stop());
      setScreenStream(null);

      // Restauramos la cámara o el dummy
      const trackToRestore = (isVideoOn && cameraTrackRef.current) 
        ? cameraTrackRef.current 
        : dummyTrackRef.current;
      
      if (trackToRestore) {
        replaceVideoTrackGlobally(trackToRestore);
      }
    } else {
      // ENCENDER SCREEN SHARE
      try {
        const res = RESOLUTIONS[selectedRes];
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: res.w },
            height: { ideal: res.h },
            frameRate: { ideal: selectedFps, max: selectedFps },
          },
          audio: true,
        });

        setScreenStream(stream);

        const screenTrack = stream.getVideoTracks()[0];
        replaceVideoTrackGlobally(screenTrack);
        if (localVideoRef.current) localVideoRef.current.srcObject = localStream;

        // Intentamos subir el bitrate si se comparte pantalla
        Object.values(callsRef.current).forEach((call) => {
          const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) {
            try {
              const params = sender.getParameters();
              if (params.encodings?.[0]) {
                params.encodings[0].maxBitrate = res.w >= 3840 ? 15000000 : res.w >= 1920 ? 8000000 : 4000000;
                sender.setParameters(params);
              }
            } catch { /* ignore */ }
          }
        });

        screenTrack.onended = () => {
          // Detectar cuando el usuario hace clic en "Dejar de compartir" desde la UI del navegador
          setScreenStream(null);
          const tr = (isVideoOn && cameraTrackRef.current) ? cameraTrackRef.current : dummyTrackRef.current;
          if (tr) replaceVideoTrackGlobally(tr);
        };
      } catch (err) {
        console.error('Screen share error', err);
      }
    }
  };

  /* ---- Configuraciones ---- */
  const switchMicrophone = async (deviceId: string) => {
    setSelectedMic(deviceId);
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const newTrack = newStream.getAudioTracks()[0];

      if (localStream) {
        localStream.getAudioTracks().forEach((t) => { t.stop(); localStream.removeTrack(t); });
        localStream.addTrack(newTrack);
        newTrack.enabled = !isMuted;

        Object.values(callsRef.current).forEach((call) => {
          const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'audio');
          if (sender) sender.replaceTrack(newTrack);
        });
      }
      showToast('Micrófono cambiado');
    } catch (err) {
      console.error('Error switching mic', err);
    }
  };

  const switchCamera = async (deviceId: string) => {
    setSelectedCamera(deviceId);
    if (!isVideoOn || screenStream) return;

    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = camStream.getVideoTracks()[0];

      if (cameraTrackRef.current) cameraTrackRef.current.stop();
      cameraTrackRef.current = newTrack;
      replaceVideoTrackGlobally(newTrack);

      showToast('Cámara cambiada');
    } catch (err) {
      console.error('Error switching cam', err);
    }
  };

  const switchSpeaker = (deviceId: string) => {
    setSelectedSpeaker(deviceId);
    document.querySelectorAll<HTMLVideoElement>('video[data-remote]').forEach((el) => {
      if ('setSinkId' in el) {
        (el as any).setSinkId(deviceId);
      }
    });
    showToast('Salida de audio cambiada');
  };

  const leaveRoom = () => router.push('/');

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    showToast('¡ID de sala copiado!');
  };

  const totalUsers = 1 + Object.keys(remoteStreams).length;

  return (
    <div className="room-layout">
      <div className="room-header">
        <div className="room-header-left">
          <div className="room-id-badge" onClick={copyRoomId}>
            <Copy size={14} /> {roomId}
          </div>
          <div className="room-user-count">
            <span className="dot" />
            <Users size={14} /> {totalUsers}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{nickname}</span>
          <button className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '13px' }} onClick={() => setShowSettings(true)}>
            <Settings size={16} /> Config
          </button>
        </div>
      </div>

      <div className="video-area">
        <div className="video-grid">
          <div ref={localContainerRef} className={`video-tile ${screenStream ? 'screen-share' : ''} ${isSpeaking && !isMuted ? 'speaking' : ''}`}>
            {isVideoOn || screenStream ? (
              <video ref={localVideoRef} autoPlay muted playsInline style={{ transform: screenStream ? 'none' : 'scaleX(-1)' }} />
            ) : (
              <>
                <video ref={localVideoRef} autoPlay muted playsInline style={{ display: 'none' }} />
                <div className="avatar-placeholder">
                  <div className="avatar-circle">{nickname.charAt(0)}</div>
                  <span className="avatar-name">{nickname}</span>
                </div>
              </>
            )}
            <div className="tile-label">
              {nickname} (Tú)
              {isMuted && <MicOff size={12} color="#ef4444" />}
            </div>
            <div className="tile-actions">
              <button
                className="tile-action-btn"
                onClick={() => {
                  const el = localContainerRef.current;
                  if (!el) return;
                  if (!document.fullscreenElement) el.requestFullscreen();
                  else document.exitFullscreen();
                }}
              >
                <Maximize size={14} />
              </button>
            </div>
          </div>

          {Object.entries(remoteStreams).map(([peerId, data]) => (
            <RemoteTile key={peerId} stream={data.stream} nickname={data.nickname} speakerDeviceId={selectedSpeaker} />
          ))}
        </div>
      </div>

      <div className="controls-bar">
        <div className="controls-group">
          <button className={`control-btn ${isMuted ? 'muted-state' : 'default'}`} onClick={toggleMute}>
            {isMuted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          <button className={`control-btn ${isVideoOn ? 'active' : 'default'}`} onClick={toggleVideo}>
            {isVideoOn ? <Video size={22} /> : <VideoOff size={22} />}
          </button>

          <button className={`control-btn ${screenStream ? 'active' : 'default'}`} onClick={toggleScreenShare}>
            <MonitorUp size={22} />
          </button>
        </div>

        <div className="controls-group">
          <button className="control-btn default" onClick={() => setShowSettings(true)}>
            <Settings size={22} />
          </button>
          <button className="control-btn danger" onClick={leaveRoom}>
            <PhoneOff size={22} />
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
          <div className="settings-panel">
            <div className="settings-header">
              <h3>⚙️ Configuración</h3>
              <button className="settings-close" onClick={() => setShowSettings(false)}><X size={18} /></button>
            </div>
            <div className="settings-body">
              <div className="settings-section">
                <div className="settings-section-title">🎤 Micrófono</div>
                <select className="settings-select" value={selectedMic} onChange={(e) => switchMicrophone(e.target.value)}>
                  {audioInputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Micrófono ${d.deviceId.slice(0, 5)}`}</option>
                  ))}
                </select>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">🎧 Salida de Audio</div>
                <select className="settings-select" value={selectedSpeaker} onChange={(e) => switchSpeaker(e.target.value)}>
                  {audioOutputs.length > 0 ? audioOutputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Altavoz ${d.deviceId.slice(0, 5)}`}</option>
                  )) : <option value="">Por defecto del sistema</option>}
                </select>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">📷 Cámara</div>
                <select className="settings-select" value={selectedCamera} onChange={(e) => switchCamera(e.target.value)}>
                  {videoInputs.length > 0 ? videoInputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Cámara ${d.deviceId.slice(0, 5)}`}</option>
                  )) : <option value="">Sin cámara detectada</option>}
                </select>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">📺 Resolución de pantalla compartida</div>
                <div className="quality-grid">
                  {RESOLUTIONS.map((r, i) => (
                    <div
                      key={r.label}
                      className={`quality-option ${selectedRes === i ? 'selected' : ''}`}
                      onClick={() => setSelectedRes(i)}
                    >
                      <div className="label">{r.label}</div>
                      <div className="sublabel">{r.w}×{r.h}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">⚡ Cuadros por segundo (FPS)</div>
                <div className="quality-grid">
                  {FPS_OPTIONS.map((fps) => (
                    <div
                      key={fps}
                      className={`quality-option ${selectedFps === fps ? 'selected' : ''}`}
                      onClick={() => setSelectedFps(fps)}
                    >
                      <div className="label">{fps} FPS</div>
                      <div className="sublabel">{fps === 30 ? 'Bajo consumo' : fps === 60 ? 'Fluido' : 'Ultra suave'}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ========== REMOTE VIDEO TILE ========== */
function RemoteTile({ stream, nickname, speakerDeviceId }: { stream: MediaStream; nickname: string; speakerDeviceId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isSpeaking = useAudioVolume(stream);

  // Consideramos "con video" si tiene tracks, si no están muteados, y si el track no es un dummy 1x1 
  // (aunque el dummy suele llegar sin ser detectado como nulo, la app sabrá que es un canvas si miramos algo específico, 
  // pero el backend de canvas no envía label. Por simplicidad, evaluaremos la propiedad habilitada).
  const videoTrack = stream.getVideoTracks()[0];
  const hasRealVideo = videoTrack && videoTrack.enabled && !videoTrack.muted && videoTrack.readyState === 'live';

  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      if (speakerDeviceId && 'setSinkId' in ref.current) {
        (ref.current as any).setSinkId(speakerDeviceId).catch(() => {});
      }
    }
  }, [stream, speakerDeviceId]);

  return (
    <div ref={containerRef} className={`video-tile ${isSpeaking ? 'speaking' : ''}`}>
      <video 
        ref={ref} 
        autoPlay 
        playsInline 
        data-remote 
        style={{ display: hasRealVideo ? 'block' : 'none' }} 
      />
      
      {!hasRealVideo && (
        <div className="avatar-placeholder">
          <div className="avatar-circle">{nickname.charAt(0)}</div>
          <span className="avatar-name">{nickname}</span>
        </div>
      )}

      <div className="tile-label">{nickname}</div>
      <div className="tile-actions">
        <button
          className="tile-action-btn"
          onClick={() => {
            const el = containerRef.current;
            if (!el) return;
            if (!document.fullscreenElement) el.requestFullscreen();
            else document.exitFullscreen();
          }}
        >
          <Maximize size={14} />
        </button>
      </div>
    </div>
  );
}
