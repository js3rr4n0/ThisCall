import { NextResponse } from 'next/server';

const rooms: Record<string, { peerId: string; nickname: string; timestamp: number }[]> = {};
// We'll just assume this runs in the same memory space as the other route for prototype purposes, 
// though Next.js in production might use separate edge functions.
// For a real app, use Redis or a database.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const resolvedParams = await params;
  const { roomId } = resolvedParams;
  const { peerId } = await request.json();
  
  if (rooms[roomId]) {
    rooms[roomId] = rooms[roomId].filter(p => p.peerId !== peerId);
  }

  return NextResponse.json({ success: true });
}
