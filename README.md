# Instagram Downloader

A userscript that adds download buttons to Instagram: photos, videos, Reels, stories,
highlights and profile pictures, at the largest size Instagram has.

## Features

- **Download** next to Save on posts, in the right-hand column on Reels, beside the controls on
  stories, and on a small bar that appears when you hover over grid tiles, messages and the
  profile picture. Photos are saved at full size, videos with their audio track, named after the
  account.
- **First frame** of story videos, saved as a photo at the video's own resolution.
- **Cover** of Reels: the picture Instagram shows before the video plays.
- **Open** any photo or video in its own tab. Click a photo to zoom; in a video tab, `S` saves
  the video and, for a story, `F` saves the first frame.
- **All posts**: the round ↗ button beside the profile's Posts tab opens every post in a new
  tab, each with all of its photos and videos (multi-photo posts side by side). More load as you
  scroll; a switch shows only multi-photo posts.
- **All highlights**: the "All" circle at the start of a profile's highlights opens every
  highlight in a new tab, with its uncropped cover and all its stories.
- **Remembers downloads**: a Download button turns red once that photo or video has been saved
  (stories are remembered for a day, everything else for good).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or another userscript manager that
   supports `@sandbox raw` / `@inject-into page`).
2. Open
   [`instagram-downloader.user.js`](https://github.com/ataberkcemunal/instagram-downloader/raw/main/instagram-downloader.user.js)
   and confirm the installation.
3. Reload Instagram. If your browser blocks pop-ups on instagram.com, allow them: Open and the
   All posts / All highlights galleries open new tabs.

### As a bookmarklet

`instagram-downloader.js` also runs as a bookmarklet: create a bookmark whose address is
`javascript:` followed by the file's contents. Each click turns the buttons on or off.

## Development

`instagram-downloader.js` is the source; the userscript is built from it:

```bash
node build.js
```

```bash
node smoke-test.js instagram-downloader.js
```

To try changes without reinstalling, install `instagram-downloader-loader.user.js` instead:
replace `/PATH/TO/instagram-downloader` in its `@require` line with the folder you cloned into,
and in Tampermonkey's extension settings turn on "Allow access to file URLs". The loader then
reads the built file from disk, so a rebuild takes effect after a page refresh.

`eski-bookmarkletler/` holds earlier bookmarklet experiments.

## Note

This project is not affiliated with Instagram or Meta. Respect the rights of the people whose
content you download and Instagram's terms of use.

## License

[MIT](LICENSE)
