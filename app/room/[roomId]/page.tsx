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
    ctx.fillStyle = '#0a0a1a';
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
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContext = new AudioContextClass();
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

  // Referencias de UI y WebRTC
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localContainerRef = useRef<HTMLDivElement>(null);
  const callsRef = useRef<Record<string, MediaConnection>>({});
  const heartbeatRef = useRef<NodeJS.Timeout>(null);
  const peerRef = useRef<Peer | null>(null);
  const initRef = useRef(false);

  // Tracks y Mixer de Audio (Solución para mezclar Mic y Pantalla)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  const systemGainRef = useRef<GainNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sysSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const mixedStreamRef = useRef<MediaStream | null>(null);

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
      let rawMicStream: MediaStream;
      try {
        // Pedimos acceso real al micrófono
        rawMicStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      } catch {
        alert('Se necesita permiso de micrófono para continuar.');
        return;
      }

      // --- SETUP AUDIO MIXER ---
      // Esto nos permite enviar un solo canal de audio que mezcle el micrófono + el audio de pantalla compartida.
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ac = new AudioContextClass();
      audioCtxRef.current = ac;

      const dest = ac.createMediaStreamDestination();
      mixedStreamRef.current = dest.stream;

      const micGain = ac.createGain();
      micGain.gain.value = 1; 
      micGain.connect(dest);
      micGainRef.current = micGain;

      const sysGain = ac.createGain();
      sysGain.gain.value = 1;
      sysGain.connect(dest);
      systemGainRef.current = sysGain;

      const rawAudioTrack = rawMicStream.getAudioTracks()[0];
      if (rawAudioTrack) {
        const micSource = ac.createMediaStreamSource(new MediaStream([rawAudioTrack]));
        micSource.connect(micGain);
        micSourceRef.current = micSource;
      }

      // Prevenir suspensión del contexto de audio en navegadores estrictos
      const resumeAc = () => { if (ac.state === 'suspended') ac.resume(); };
      window.addEventListener('click', resumeAc);
      window.addEventListener('touchstart', resumeAc);

      // --- SETUP VIDEO DUMMY ---
      // WebRTC necesita inicializar el "Sender" de video para que podamos cambiar a cámara/pantalla sin tener que renegociar.
      const dummyTrack = createDummyVideoTrack();
      dummyTrackRef.current = dummyTrack;
      currentVideoTrackRef.current = dummyTrack;

      // --- FLUJO LOCAL ---
      const finalStream = new MediaStream([
        dest.stream.getAudioTracks()[0],
        dummyTrack
      ]);
      setLocalStream(finalStream);

      await enumerateDevices();

      // --- WEBRTC PEERJS ---
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
                const call = currentPeer.call(p.peerId, finalStream, {
                  metadata: { nickname: storedNickname },
                  sdpTransform: (sdp: string) => {
                    // Forzar audio estéreo de alta fidelidad (Discord High-Quality)
                    return sdp.replace(
                      /useinbandfec=1/g,
                      'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=510000; cbr=1'
                    );
                  }
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
        call.answer(finalStream, {
          sdpTransform: (sdp: string) => {
            return sdp.replace(
              /useinbandfec=1/g,
              'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=510000; cbr=1'
            );
          }
        });
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
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close();
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
    
    if (localStream) {
      localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
      localStream.addTrack(newTrack);
    }
    
    Object.values(callsRef.current).forEach((call) => {
      const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        sender.replaceTrack(newTrack).catch(err => console.warn('replaceTrack failed:', err));
      }
    });
  };

  /* ---- Botones de Control ---- */
  const toggleMute = () => {
    // Apagamos el nodo de micrófono en el mixer, el sistema de audio sigue activo.
    if (micGainRef.current) {
      const currentlyMuted = micGainRef.current.gain.value === 0;
      micGainRef.current.gain.value = currentlyMuted ? 1 : 0;
      setIsMuted(!currentlyMuted);
    }
  };

  const toggleVideo = async () => {
    if (!localStream) return;

    if (isVideoOn) {
      if (cameraTrackRef.current) {
        cameraTrackRef.current.stop();
        cameraTrackRef.current = null;
      }
      setIsVideoOn(false);
      
      if (!screenStream && dummyTrackRef.current) {
        replaceVideoTrackGlobally(dummyTrackRef.current);
      }
    } else {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: selectedCamera ? { deviceId: { exact: selectedCamera } } : true,
        });
        const videoTrack = camStream.getVideoTracks()[0];
        cameraTrackRef.current = videoTrack;
        setIsVideoOn(true);

        if (!screenStream) {
          replaceVideoTrackGlobally(videoTrack);
          if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
        }
      } catch (err) {
        console.error('Error al encender cámara', err);
        showToast('No se pudo activar la cámara');
      }
    }
  };

  const disableScreenShareGlobally = () => {
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      setScreenStream(null);
    }
    
    if (sysSourceRef.current) {
      sysSourceRef.current.disconnect();
      sysSourceRef.current = null;
    }

    const trackToRestore = (isVideoOn && cameraTrackRef.current) 
      ? cameraTrackRef.current 
      : dummyTrackRef.current;
    
    if (trackToRestore) replaceVideoTrackGlobally(trackToRestore);
  };

  const toggleScreenShare = async () => {
    if (screenStream) {
      disableScreenShareGlobally();
    } else {
      try {
        const res = RESOLUTIONS[selectedRes];
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: res.w },
            height: { ideal: res.h },
            frameRate: { ideal: selectedFps, max: selectedFps },
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
          }, // Audio del sistema crudo sin filtros destructivos
        });

        setScreenStream(stream);

        // -- Inyectar Audio de Sistema al Mixer --
        const screenAudioTrack = stream.getAudioTracks()[0];
        if (screenAudioTrack && audioCtxRef.current && systemGainRef.current) {
          const sysSource = audioCtxRef.current.createMediaStreamSource(new MediaStream([screenAudioTrack]));
          sysSource.connect(systemGainRef.current);
          sysSourceRef.current = sysSource;
        }

        // -- Optimización extrema de fluidez (60/120fps sin lag) --
        const screenVideoTrack = stream.getVideoTracks()[0];
        if ('contentHint' in screenVideoTrack) {
          screenVideoTrack.contentHint = 'motion'; // Fuerza al navegador a priorizar FPS sobre nitidez de píxel
        }

        replaceVideoTrackGlobally(screenVideoTrack);
        if (localVideoRef.current) localVideoRef.current.srcObject = localStream;

        Object.values(callsRef.current).forEach((call) => {
          const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) {
            try {
              const params = sender.getParameters();
              if (params.encodings?.[0]) {
                // Bitrates mucho más altos (50Mbps para 4K, 15Mbps para 1080p)
                const targetBitrate = res.w >= 3840 ? 50000000 : res.w >= 1920 ? 15000000 : 8000000;
                params.encodings[0].maxBitrate = targetBitrate;
                params.encodings[0].maxFramerate = selectedFps;
              }
              // Obliga a WebRTC a NO sacrificar fotogramas si la red baja un poco, sino sacrificar resolución estática temporalmente
              (params as any).degradationPreference = 'maintain-framerate';
              
              sender.setParameters(params);
            } catch { /* ignore */ }
          }
        });

        screenVideoTrack.onended = () => disableScreenShareGlobally();
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

      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
      }

      if (audioCtxRef.current && micGainRef.current) {
        const newMicSource = audioCtxRef.current.createMediaStreamSource(new MediaStream([newTrack]));
        newMicSource.connect(micGainRef.current);
        micSourceRef.current = newMicSource;
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
