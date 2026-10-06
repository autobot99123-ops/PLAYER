# Player

A local video player that runs in Chrome. Lists your videos by name, plays them
with a picture-in-picture popup that follows you across tabs, and can boost the
audio.

No build step, no dependencies. Node is only used to list files and stream them
with byte ranges so seeking works.

## Run

```bash
npm start
```

Then open <http://127.0.0.1:4173>.

## Point it at a different folder

Defaults to `~/Videos`.

```powershell
$env:VIDEOS_DIR = "D:\Movies"
npm start
```

You can also just drag files onto the window.

## Keys

| Key | Action |
|---|---|
| `Space` / `K` | play / pause |
| `S` | stop |
| `←` / `J`, `→` / `L` | seek 10s (hold `Shift` for 1s) |
| `↑` / `↓` | boost up / down |
| `M` | mute |
| `0`–`9` | jump to 0–90% |
| `O` | picture-in-picture popup |
| `F` | fullscreen |
| `N` / `P` | next / previous video |
| `B` | open library |
| `Esc` | close library, or leave fullscreen |
| `F11` | browser fullscreen |

Digits work on the numpad too.

## Install as a desktop app

The page is a PWA. Use the **Install** button in the header, or the install icon
in Chrome's address bar. It opens in its own window with its own taskbar entry
and no address bar.

Requires `localhost` or HTTPS, so Chrome will not offer the install over `file://`.

## About the audio boost

The `Boost` slider applies a Web Audio gain stage **before** the Windows mixer,
which is why it can make quiet output loud.

At 100% the player uses plain native `<video>` audio. The Web Audio graph is only
built once you push the slider past 100%, because a media element connected to a
`MediaElementSource` can only be heard through that graph — if Chrome suspends
the AudioContext (background windows, installed app windows) the video would go
completely silent and the source cannot be detached again. A watchdog drops the
boost back to 100% if the context stops running.

## Supported files

Anything Chrome can play: MP4 (H.264 + AAC), WebM, and MOV when the codecs line
up. Matroska (`.mkv`) only works if it contains H.264/AAC rather than something
like DTS or TrueHD — if a file shows a decode error, that is a codec limit, not
a bug in the player.

## Layout

```
server.js            static files, /api/videos listing, range streaming
public/index.html    markup
public/styles.css    dark + amber theme
public/app.js        player, keys, popup, audio graph
public/sw.js         offline shell for the installed app
public/manifest.webmanifest
public/make-icons.ps1  regenerates the icon set from one image
```

## Credits

Icons are generated from your own `logo.jpg` via `public/make-icons.ps1`.