# YouTube Jukebox

YouTube Jukebox lets you play YouTube tracks (single videos or whole playlists) inside **Foundry VTT** so that everyone hears the same thing.  
It also supports a second, optional **Overlay** track for ambience or SFX that can play at the same time as the main music.  
Libraries are saved in the world (GM-managed) so you don’t have to re-import every session.

---

## 🎵 Key Features

- **Main player**: Play/pause/stop/seek, previous/next, auto-advance to the next track.  
- **Overlay player (OL)**: Play a second track simultaneously (e.g., ambience + voiceover/SFX).  
  - Separate pause/stop and per-client overlay volume.  
  - No auto-advance (by design).  
- **Saved library**: GM can store tracks under Groups (playlists).  
  - Import single videos or entire playlists via URL.  
- **Drag & move tracks** between groups; remove individual tracks or delete whole groups.  
- **Inline group rename**: Double-click a group name to rename it.  
- **Per-client volumes**: Each player controls their own main and overlay volume via a hover popover attached to the music icon — doesn’t affect others.  
- **Draggable music icon (FAB)**:  
  - Move the icon anywhere on screen.  
  - Position is saved per client, and the volume popover follows it.  
- **Dynamic player window**:  
  - Whenever you play a track (main or overlay), a player appears on screen.  
  - It can be moved around freely and disappears automatically once the corresponding track stops.  
- **Keybinding**:  
  - Open/close the Jukebox with a hotkey (default **Ctrl/Cmd + K**).  
  - Can be changed from Foundry’s Keybindings UI.  
- **Permissions**: Choose who can control playback globally (GM only or everyone).  
- **Optional YouTube API key**:  
  - Fetches proper playlist/video titles.  
  - Without it, the module falls back to a public title lookup (slower or limited).  

---

## 🚀 Support & Updates

All upcoming updates will be **free**, but if you'd like to get early access and vote on which upgrades I'll work on first, please consider supporting me:

👉 [Support the project on Patreon](https://patreon.com/c/Jotape_Dev)

---

## ⚠️ Notes

This is my first project, so bugs may occur, especially since it was made for **Foundry VTT version 12**.  
I intend to bring more updates over time.
