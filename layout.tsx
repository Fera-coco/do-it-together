import './globals.css'
import type { Metadata } from 'next'
export const metadata: Metadata = { title: 'do it together', description: 'Social accountability with someone who notices.' }
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html> }
