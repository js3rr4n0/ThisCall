import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'NextCall | Video Meetings',
  description: 'High performance WebRTC video calls with 60fps screen sharing.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          {children}
        </main>
      </body>
    </html>
  )
}
