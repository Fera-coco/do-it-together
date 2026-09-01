import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Do It Together',
    short_name: 'Do It Together',
    description: 'Social accountability with someone who notices.',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf8f3',
    theme_color: '#514394',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }
}
