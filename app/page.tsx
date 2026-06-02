'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Headphones, Plus, LogIn } from 'lucide-react';

export default function Home() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'menu' | 'create' | 'join'>('menu');

  const generateRoomId = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) return;
    const newRoomId = generateRoomId();
    localStorage.setItem('nickname', nickname.trim());
    router.push(`/room/${newRoomId}`);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || !roomId.trim()) return;
    localStorage.setItem('nickname', nickname.trim());
    router.push(`/room/${roomId.trim().toUpperCase()}`);
  };

  return (
    <div className="lobby-wrapper">
      <div className="lobby-card">
        {/* Logo */}
        <div className="lobby-logo">
          <Headphones size={30} color="white" />
        </div>
        <h1 className="lobby-title">NextCall</h1>
        <p className="lobby-subtitle">Videollamadas gaming · Screen share 4K @ 120fps</p>

        {mode === 'menu' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button className="btn btn-primary btn-full" onClick={() => setMode('create')}>
              <Plus size={20} /> Crear Sala
            </button>
            <button className="btn btn-secondary btn-full" onClick={() => setMode('join')}>
              <LogIn size={20} /> Unirme a Sala
            </button>
          </div>
        )}

        {mode === 'create' && (
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Tu apodo</label>
              <input
                type="text"
                className="form-input"
                placeholder="Ej: ShadowWolf"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                required
                autoFocus
                maxLength={20}
              />
            </div>
            <button type="submit" className="btn btn-primary btn-full">
              <Plus size={18} /> Crear y entrar
            </button>
            <button type="button" className="btn btn-secondary btn-full" onClick={() => setMode('menu')}>
              ← Volver
            </button>
          </form>
        )}

        {mode === 'join' && (
          <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Tu apodo</label>
              <input
                type="text"
                className="form-input"
                placeholder="Ej: NightHawk"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                required
                autoFocus
                maxLength={20}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">ID de sala</label>
              <input
                type="text"
                className="form-input"
                placeholder="Ej: A3X9K2"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                required
                maxLength={8}
                style={{ textTransform: 'uppercase', letterSpacing: '3px', fontWeight: 700, textAlign: 'center', fontSize: '20px' }}
              />
            </div>
            <button type="submit" className="btn btn-primary btn-full">
              <LogIn size={18} /> Unirme
            </button>
            <button type="button" className="btn btn-secondary btn-full" onClick={() => setMode('menu')}>
              ← Volver
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
