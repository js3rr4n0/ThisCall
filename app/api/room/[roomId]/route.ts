import { NextResponse } from 'next/server';

// Global variable to persist across hot reloads in development
const globalForRooms = globalThis as unknown as {
  rooms: Record<string, { peerId: string; nickname: string; timestamp: number }[]>
};

const rooms = globalForRooms.rooms || {};
if (process.env.NODE_ENV !== 'production') globalForRooms.rooms = rooms;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const resolvedParams = await params;
  const { roomId } = resolvedParams;
  const now = Date.now();
  
  if (rooms[roomId]) {
    rooms[roomId] = rooms[roomId].filter(p => now - p.timestamp < 15000); // 15s timeout
  }

  return NextResponse.json({ peers: rooms[roomId] || [] });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const resolvedParams = await params;
  const { roomId } = resolvedParams;
  const { peerId, nickname } = await request.json();
  
  if (!rooms[roomId]) {
    rooms[roomId] = [];
  }

  const existingIndex = rooms[roomId].findIndex(p => p.peerId === peerId);
  if (existingIndex >= 0) {
    rooms[roomId][existingIndex].timestamp = Date.now();
    rooms[roomId][existingIndex].nickname = nickname;
  } else {
    rooms[roomId].push({ peerId, nickname, timestamp: Date.now() });
  }

  return NextResponse.json({ success: true, peers: rooms[roomId] });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const resolvedParams = await params;
  const { roomId } = resolvedParams;
  
  try {
    const { peerId } = await request.json();
    if (rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(p => p.peerId !== peerId);
    }
  } catch (e) {
    // ignore
  }

  return NextResponse.json({ success: true });
}
