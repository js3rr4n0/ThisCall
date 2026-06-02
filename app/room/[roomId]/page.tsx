'use client';

import { useEffect, useState, useRef, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, PhoneOff,
  Settings, Maximize, Copy, Users, X, Volume2
} from 'lucide-react';
import type Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';

/* ========== DUMMY TRACK GENERATOR ========== */
let globalDummyCanvas: HTMLCanvasElement | null = null;
const createDummyVideoTrack = (): MediaStreamTrack => {
  if (!globalDummyCanvas) {
    globalDummyCanvas = document.createElement('canvas');
    globalDummyCanvas.width = 2;
    globalDummyCanvas.height = 2;
    const ctx = globalDummyCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0a0a1a';
      ctx.fillRect(0, 0, 2, 2);
      // Animación a 1fps para evitar que WebRTC considere la pista como "muerta" o "silenciada"
      setInterval(() => {
        ctx.fillStyle = ctx.fillStyle === '#0a0a1a' ? '#0b0b1b' : '#0a0a1a';
        ctx.fillRect(0, 0, 2, 2);
      }, 1000);
    }
  }
  return globalDummyCanvas.captureStream(1).getVideoTracks()[0];
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

  // Volúmenes Locales
  const [micVolume, setMicVolume] = useState(1);
  const [sysVolume, setSysVolume] = useState(1);

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
  const rawMicStreamRef = useRef<MediaStream | null>(null);

  const currentVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const dummyTrackRef = useRef<MediaStreamTrack | null>(null);

  const isSpeaking = useAudioVolume(localStream);

  // Efectos para sincronizar volumen
  useEffect(() => {
    if (micGainRef.current) {
      micGainRef.current.gain.value = isMuted ? 0 : micVolume;
    }
  }, [micVolume, isMuted]);

  useEffect(() => {
    if (systemGainRef.current) {
      systemGainRef.current.gain.value = sysVolume;
    }
  }, [sysVolume]);

  // Sincronizar el video local automáticamente (solo montaje inicial)
  useEffect(() => {
    if (localVideoRef.current && localStream && !localVideoRef.current.srcObject) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

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
        rawMicStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        rawMicStreamRef.current = rawMicStream;
      } catch (err) {
        console.warn('Microphone failed or denied, using silent track to keep app running.', err);
        // Create a silent audio track as fallback so the app DOES NOT crash
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const fallbackAc = new AudioContextClass();
        const oscillator = fallbackAc.createOscillator();
        const dst = fallbackAc.createMediaStreamDestination();
        oscillator.connect(dst);
        oscillator.start();
        const silentTrack = dst.stream.getAudioTracks()[0];
        silentTrack.enabled = false; // mute it
        rawMicStream = new MediaStream([silentTrack]);
        rawMicStreamRef.current = rawMicStream;
      }

      const rawAudioTrack = rawMicStream.getAudioTracks()[0];
      const dummyTrack = createDummyVideoTrack();
      dummyTrackRef.current = dummyTrack;
      currentVideoTrackRef.current = dummyTrack;

      // --- FLUJO LOCAL DIRECTO (Sin Mixer inicialmente para evitar bugs en Safari) ---
      const finalStream = new MediaStream([
        rawAudioTrack,
        dummyTrack
      ]);
      setLocalStream(finalStream);


      await enumerateDevices();

      // --- WEBRTC PEERJS ---
      const PeerJS = (await import('peerjs')).default;
      currentPeer = new PeerJS({
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });
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
        call.answer(finalStream);
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
      // Eliminar jitter buffer para lograr 0-delay en la transmisión
      if (call.peerConnection) {
        call.peerConnection.getReceivers().forEach((receiver) => {
          if ('playoutDelayHint' in receiver) {
            (receiver as any).playoutDelayHint = 0;
          }
        });
      }

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
  const replaceAudioTrackGlobally = (newTrack: MediaStreamTrack) => {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => localStream.removeTrack(t));
      localStream.addTrack(newTrack);
    }
    Object.values(callsRef.current).forEach((call) => {
      const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        sender.replaceTrack(newTrack).catch(err => console.warn('replaceTrack audio failed:', err));
      }
    });
  };

  const replaceVideoTrackGlobally = (newTrack: MediaStreamTrack) => {
    currentVideoTrackRef.current = newTrack;
    
    if (localStream) {
      localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
      localStream.addTrack(newTrack);
      
      // FORZAR ACTUALIZACIÓN DEL VIDEO LOCAL en navegadores estrictos
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = new MediaStream(localStream.getTracks());
      }
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
    // Mutear directamente la pista base silencia todo (incluso el mixer si está activo)
    const track = rawMicStreamRef.current?.getAudioTracks()[0];
    if (track) {
      const nextState = !track.enabled;
      track.enabled = nextState;
      setIsMuted(!nextState);
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

    // Restaurar audio crudo (sin mixer)
    const rawAudio = rawMicStreamRef.current?.getAudioTracks()[0];
    if (rawAudio) replaceAudioTrackGlobally(rawAudio);
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
            // @ts-ignore
            latency: 0,
          },
          audio: {
            echoCancellation: true, // Fundamental para evitar que la otra persona se escuche a sí misma
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            // @ts-ignore
            suppressLocalAudioPlayback: true, // Evitar loopback local
          }, // Audio del sistema con cancelación de eco activada para prevenir el audio doble
        });

        setScreenStream(stream);

        // -- Inyectar Audio de Sistema al Mixer (Solo si hay audio) --
        const screenAudioTrack = stream.getAudioTracks()[0];
        let audioTrackToTransmit = rawMicStreamRef.current?.getAudioTracks()[0];

        if (screenAudioTrack) {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          if (!audioCtxRef.current) audioCtxRef.current = new AudioContextClass();
          const ac = audioCtxRef.current;
          if (ac.state === 'suspended') ac.resume();

          const dest = ac.createMediaStreamDestination();
          mixedStreamRef.current = dest.stream;

          const sysGain = ac.createGain();
          sysGain.gain.value = sysVolume;
          sysGain.connect(dest);
          systemGainRef.current = sysGain;

          const sysSource = ac.createMediaStreamSource(new MediaStream([screenAudioTrack]));
          sysSource.connect(sysGain);
          sysSourceRef.current = sysSource;

          const micGain = ac.createGain();
          micGain.gain.value = micVolume;
          micGain.connect(dest);
          micGainRef.current = micGain;

          if (rawMicStreamRef.current) {
            const micSource = ac.createMediaStreamSource(rawMicStreamRef.current);
            micSource.connect(micGain);
            micSourceRef.current = micSource;
          }

          audioTrackToTransmit = dest.stream.getAudioTracks()[0];
        }

        // -- Optimización extrema de fluidez (60/120fps sin lag) --
        const screenVideoTrack = stream.getVideoTracks()[0];
        if ('contentHint' in screenVideoTrack) {
          screenVideoTrack.contentHint = 'motion';
        }

        replaceVideoTrackGlobally(screenVideoTrack);
        if (audioTrackToTransmit) {
          replaceAudioTrackGlobally(audioTrackToTransmit);
        }

        Object.values(callsRef.current).forEach((call) => {
          const sender = call.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) {
            try {
              const params = sender.getParameters();
              if (params.encodings?.[0]) {
                // Bitrates masivos: 50Mbps para 4K, 30Mbps para 1080p, 15Mbps para 720p/480p
                const targetBitrate = res.w >= 3840 ? 50000000 : res.w >= 1920 ? 30000000 : 15000000;
                params.encodings[0].maxBitrate = targetBitrate;
                (params.encodings[0] as any).minBitrate = targetBitrate / 2; // Forzar a WebRTC a mantener el bitrate
                params.encodings[0].maxFramerate = selectedFps;
                params.encodings[0].scaleResolutionDownBy = 1.0; // Obligar a NUNCA bajar la resolución
              }
              // Prioridad absoluta a la resolución para que no se vea borroso bajo ninguna circunstancia
              (params as any).degradationPreference = 'maintain-resolution';
              
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
      rawMicStreamRef.current = newStream;
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
            <video 
              ref={localVideoRef} 
              autoPlay 
              muted 
              playsInline 
              style={{ 
                transform: screenStream ? 'none' : 'scaleX(-1)',
                display: (isVideoOn || screenStream) ? 'block' : 'none'
              }} 
            />
            {!(isVideoOn || screenStream) && (
              <div className="avatar-placeholder">
                <div className="avatar-circle">{nickname.charAt(0)}</div>
                <span className="avatar-name">{nickname}</span>
              </div>
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
                <div style={{ marginTop: '12px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Volumen de tu Voz</label>
                  <input 
                    type="range" min="0" max="2" step="0.1" 
                    value={micVolume} onChange={(e) => setMicVolume(parseFloat(e.target.value))}
                    style={{ width: '100%', marginTop: '5px' }}
                  />
                </div>
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
                <div style={{ marginTop: '15px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Volumen de Transmisión (Juego/PC)</label>
                  <input 
                    type="range" min="0" max="2" step="0.1" 
                    value={sysVolume} onChange={(e) => setSysVolume(parseFloat(e.target.value))}
                    style={{ width: '100%', marginTop: '5px' }}
                  />
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isSpeaking = useAudioVolume(stream);

  const [volume, setVolume] = useState(1);
  const [showVolume, setShowVolume] = useState(false);
  const [isDummy, setIsDummy] = useState(true);

  const videoTrack = stream.getVideoTracks()[0];
  const isReceivingVideo = videoTrack && videoTrack.enabled && !videoTrack.muted && videoTrack.readyState === 'live';

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  // Detectar si el video recibido es el track dummy (1x1) o una transmisión real
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const checkRes = () => {
      // Chrome a veces reporta 0x0 antes de cargar, o 2x2 para el dummy
      setIsDummy(video.videoWidth <= 2 || video.videoHeight <= 2);
    };

    checkRes();
    video.addEventListener('resize', checkRes);
    video.addEventListener('loadedmetadata', checkRes);
    
    const interval = setInterval(checkRes, 500); // Polling por seguridad

    return () => {
      video.removeEventListener('resize', checkRes);
      video.removeEventListener('loadedmetadata', checkRes);
      clearInterval(interval);
    };
  }, [stream]);

  useEffect(() => {
    if (stream) {
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(e => console.warn('Video Autoplay bloqueado por el navegador', e));
      }
      if (audioRef.current) {
        audioRef.current.srcObject = stream;
        if (speakerDeviceId && 'setSinkId' in audioRef.current) {
          (audioRef.current as any).setSinkId(speakerDeviceId).catch(() => {});
        }
        audioRef.current.play().catch(e => console.warn('Audio Autoplay bloqueado por el navegador', e));
      }
    }
  }, [stream, speakerDeviceId]);

  return (
    <div ref={containerRef} className={`video-tile ${isSpeaking ? 'speaking' : ''}`}>
      <audio ref={audioRef} autoPlay playsInline />
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline
        muted
        data-remote 
        style={isReceivingVideo && !isDummy ? { display: 'block' } : { width: 0, height: 0, opacity: 0, position: 'absolute', pointerEvents: 'none' }} 
      />
      
      {(!isReceivingVideo || isDummy) && (
        <div className="avatar-placeholder">
          <div className="avatar-circle">{nickname.charAt(0)}</div>
          <span className="avatar-name">{nickname}</span>
        </div>
      )}

      <div className="tile-label">{nickname}</div>
      <div className="tile-actions">
        {showVolume && (
          <input 
            type="range" min="0" max="1" step="0.05"
            value={volume} onChange={(e) => setVolume(parseFloat(e.target.value))}
            style={{ width: '70px', marginRight: '8px', cursor: 'pointer' }}
          />
        )}
        <button className="tile-action-btn" onClick={() => setShowVolume(!showVolume)} title="Ajustar Volumen">
          <Volume2 size={14} />
        </button>
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
