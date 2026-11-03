// Data that drives the programmatic-SEO page generator.
// Add rows here and re-run `node seo/generate.mjs` to mint new pages.

export const SITE = {
  name: "SubCaptions",
  // Set this to your real domain before deploying; used in canonicals + sitemap.
  origin: "https://subcaptions.com",
  tagline: "Subtitle any YouTube video in your browser, then translate it.",
};

// Number of target languages offered in the translator and the editor. This is the
// count of options in the language selects in /index.html and /translate.html (both
// carry the same 44 languages). Update it here if those lists change.
export const LANGUAGE_COUNT = 44;

// Target languages we generate "translate SRT to X" pages for.
// volume is a rough relative search-intent weight (1-5) used only to order the index.
export const TARGET_LANGUAGES = [
  { name: "Spanish", code: "es", volume: 5, native: "Español", speakers: "560M+", note: "the highest-demand pair for English creators reaching Latin America and Spain" },
  { name: "Portuguese (Brazil)", code: "pt-BR", volume: 5, native: "Português", speakers: "210M+", note: "Brazil is one of the fastest-growing YouTube audiences in the world" },
  { name: "French", code: "fr", volume: 4, native: "Français", speakers: "300M+", note: "France, Canada, and much of West Africa" },
  { name: "German", code: "de", volume: 4, native: "Deutsch", speakers: "130M+", note: "a high-CPM audience that strongly prefers localized captions" },
  { name: "Japanese", code: "ja", volume: 4, native: "日本語", speakers: "125M+", note: "where line length and reading speed matter more than almost anywhere" },
  { name: "Korean", code: "ko", volume: 4, native: "한국어", speakers: "80M+", note: "a hugely engaged audience for tutorials, gaming, and K-content reactions" },
  { name: "Hindi", code: "hi", volume: 4, native: "हिन्दी", speakers: "600M+", note: "India is YouTube's largest single market by users" },
  { name: "Arabic", code: "ar", volume: 4, native: "العربية", speakers: "400M+", note: "right-to-left captions for the MENA region" },
  { name: "Chinese (Simplified)", code: "zh-CN", volume: 4, native: "简体中文", speakers: "1.1B+", note: "for creators distributing on Bilibili and beyond" },
  { name: "Russian", code: "ru", volume: 3, native: "Русский", speakers: "250M+", note: "a large audience for long-form and educational content" },
  { name: "Italian", code: "it", volume: 3, native: "Italiano", speakers: "65M+", note: "a localization-friendly European market" },
  { name: "Turkish", code: "tr", volume: 3, native: "Türkçe", speakers: "85M+", note: "one of the most active YouTube audiences per capita" },
  { name: "Indonesian", code: "id", volume: 3, native: "Bahasa Indonesia", speakers: "200M+", note: "a top-5 YouTube market by watch time" },
  { name: "Vietnamese", code: "vi", volume: 3, native: "Tiếng Việt", speakers: "85M+", note: "a rapidly growing mobile-first audience" },
  { name: "Polish", code: "pl", volume: 2, native: "Polski", speakers: "45M+", note: "central Europe's largest single-language market" },
  { name: "Dutch", code: "nl", volume: 2, native: "Nederlands", speakers: "25M+", note: "a high-CPM, English-fluent but localization-appreciative audience" },
  { name: "Thai", code: "th", volume: 2, native: "ไทย", speakers: "60M+", note: "a strong market for entertainment and tutorials" },
  { name: "Ukrainian", code: "uk", volume: 2, native: "Українська", speakers: "40M+", note: "growing demand for localized educational content" },
  { name: "Filipino", code: "tl", volume: 2, native: "Filipino", speakers: "45M+", note: "a highly English-fluent but engagement-heavy audience" },
  { name: "Swedish", code: "sv", volume: 2, native: "Svenska", speakers: "10M+", note: "a small but high-value Nordic market" },
];

// The default source language for "translate to X" pages.
export const DEFAULT_SOURCE = { name: "English", code: "en" };

// Captioner-intent guide pages. These target the HERO product (the editor) and
// their CTA opens the captioner (/). This is where the differentiated search
// intent lives: people looking to create or add subtitles on a video, not just
// translate an existing file.
export const CAPTIONER_PAGES = [
  {
    slug: "add-subtitles-to-youtube-video",
    title: "How to Add Subtitles to a YouTube Video (Free, No Software)",
    h1: "Add subtitles to your YouTube video",
    metaDesc: "Add subtitles to any YouTube video for free, right in your browser. Paste the link, caption on top of the video, download the .srt, and upload it in YouTube Studio. No software, no signup.",
    intro: "You don't need desktop software or YouTube's clunky editor to caption a video. Paste your link, play it here, and type each line as it's spoken. Mark when each caption starts and ends with a keystroke, watch it appear on the video, then download a clean .srt and upload it back in YouTube Studio.",
    steps: [
      "Paste your YouTube URL to load the video here.",
      "Press play. When a line starts, press S; when it ends, press E.",
      "Type the caption. It appears on the video instantly so timing is never a guess.",
      "Work through the video, then download your .srt.",
      "In YouTube Studio, open Subtitles, add a language, and upload the .srt.",
    ],
    faq: [
      ["Does it transcribe the audio for me?", "Not for YouTube links. YouTube and Vimeo block audio download, so auto-captions cannot read them, and you type each line yourself with keyboard shortcuts while the captions show on the video. Solo and Team plans add AI auto-captions for uploaded video files and for direct, Dropbox, Google Drive, and Frame.io links. Review any auto-generated captions before you publish them."],
      ["Will the subtitles stay in sync on YouTube?", "Yes. You set each in and out point against the actual video, and the exported .srt carries those exact timecodes, so it lines up when you upload it."],
      ["Do I lose my work if I close the tab?", "No. Your captions are saved in your browser on your device for each video, so you can close the tab and pick up where you left off. If you are signed in, the project is also saved to your SubCaptions account."],
      ["Is it really free?", "Captioning videos up to 45 minutes, exporting .srt and .vtt files, and one translation per video are free. Solo and Team plans add full-length videos, unlimited translations, AI auto-captions, and video upload. See the pricing page for details."],
    ],
  },
  {
    slug: "youtube-subtitle-editor",
    title: "Free YouTube Subtitle Editor (In Your Browser)",
    h1: "A subtitle editor that works on top of the video",
    metaDesc: "A free YouTube subtitle editor that runs in your browser. Create and time captions on top of the real video, edit any line, and export .srt or .vtt. No install, no signup.",
    intro: "Most subtitle editors make you scrub a waveform in a separate window from the video. This one puts the captions on the video. Load any YouTube link, build your captions in time with what's on screen, edit any line, and export. Nothing to install.",
    steps: [
      "Load your video by pasting its YouTube URL.",
      "Create captions with play, mark-in (S), mark-out (E), and type.",
      "Click any caption to jump to it; edit the text or retime it.",
      "Export .srt or .vtt, or translate the whole set in one click.",
    ],
    faq: [
      ["What makes this different from desktop subtitle editors?", "It runs in the browser with the video front and center, so you caption in context and see each line on screen as you save it. No install and no project files. Your work is saved in your browser, and in your account if you sign in."],
      ["Can I edit subtitles I already made here?", "Yes. Reopen the same video in the same browser and your captions are still there to edit. If you are signed in, they are also available on your other devices. To translate or convert an existing file, use the file translator."],
      ["What formats can I export?", "Standard .srt and .vtt, which import into YouTube, Premiere, DaVinci Resolve, Final Cut, and CapCut."],
    ],
  },
  {
    slug: "how-to-make-an-srt-file",
    title: "How to Make an SRT File (Step by Step, Free)",
    h1: "Make an SRT file from any video",
    metaDesc: "Learn how to make an SRT subtitle file for free. Load a YouTube video, type captions in time, and export a properly formatted .srt. No software needed.",
    intro: "An SRT file is just numbered captions with start and end timecodes. The hard part is getting the timing right, which is why building it on top of the video matters. Load your video, caption it here, and export a correctly formatted .srt with the timecodes handled for you.",
    steps: [
      "Paste a YouTube URL to load the video.",
      "Play it and mark the in and out point for each line (S and E).",
      "Type each caption; the format and numbering are handled automatically.",
      "Download a valid .srt, ready for YouTube or any editor.",
    ],
    faq: [
      ["What does an SRT file look like inside?", "Each entry is a number, a timecode line like 00:00:01,000 to 00:00:04,000, and the caption text. This tool writes that format for you, so you never type timecodes by hand."],
      ["Can I make a VTT file instead?", "Yes. Export to .vtt with one click; it's the same captions in the WebVTT format used by web players."],
      ["Do I need to know the timecodes in advance?", "No. You mark them by pressing a key while the video plays, so the timing comes from the video itself."],
    ],
  },
  {
    slug: "subtitle-a-video-online",
    title: "Subtitle a Video Online, Free (No Download)",
    h1: "Subtitle a video online, free",
    metaDesc: "Subtitle a video online for free with no download. Paste a YouTube link, caption it in your browser on top of the video, and export .srt or .vtt.",
    intro: "Subtitle a video without installing anything. Paste a YouTube link, caption it here in time with the video, and export. Captioning runs in your browser, and your work is saved on your device.",
    steps: [
      "Open the captioner and paste your YouTube URL.",
      "Play, mark in and out, and type your captions.",
      "Preview them on the video as you go.",
      "Export .srt or .vtt, or translate into another language.",
    ],
    faq: [
      ["Do I have to upload my video?", "No. When you paste a link, the video plays from YouTube, Vimeo, or wherever it is hosted. Your captions are built in your browser and saved on your device, and in your account if you sign in. Uploading a video file is optional and needs a Solo or Team plan; uploaded files are stored on our cloud storage and deleted after 7 days."],
      ["Can I subtitle a video that isn't mine?", "You can caption any YouTube video for things like language practice or fan subs. Respect the original creator's rights when you publish or share the result."],
      ["Is there a time limit on the video?", "Videos up to 45 minutes are free. Solo and Team plans remove the limit."],
    ],
  },
  {
    slug: "add-captions-to-shorts-reels-tiktok",
    title: "Add Captions to YouTube Shorts, Reels & TikToks",
    h1: "Caption your Shorts, Reels, and TikToks",
    metaDesc: "Add captions to YouTube Shorts, Instagram Reels, and TikToks. Caption the video in your browser, export an .srt, and upload it where you publish. Free, no signup.",
    intro: "Most short-form video is watched on mute, so captions are what keep people watching. Caption your short here against the actual video, export an .srt, and use it wherever you publish. Fast enough to do every video.",
    steps: [
      "Paste the YouTube link for your short.",
      "Caption it line by line with the keyboard shortcuts.",
      "Export the .srt.",
      "Upload it to YouTube, or import it into CapCut or another video editor for Reels and TikTok.",
    ],
    faq: [
      ["Can I use this for TikTok and Reels, not just YouTube?", "Yes. Caption against the YouTube version (or any copy you've uploaded), export the .srt, and import it into CapCut or your editor to add the captions to the vertical video for any platform."],
      ["Why not just use auto-captions?", "Auto-captions often miss names, slang, and fast speech, and they need review. Typing the captions gives you control over every line and its timing. Solo and Team plans also offer AI auto-captions for uploaded video files, which you edit in the same editor."],
      ["Can I translate my short's captions?", `Yes, into ${LANGUAGE_COUNT} languages, then download each as its own file. Free accounts get one translation per video; Solo and Team plans have no limit.`],
    ],
  },
  {
    slug: "free-subtitle-maker",
    title: "Free Subtitle Maker (No Signup, No Watermark)",
    h1: "A free subtitle maker that respects your time",
    metaDesc: "A genuinely free subtitle maker. Create timed captions on top of a YouTube video and export .srt or .vtt. No signup, no watermark, work saved in your browser.",
    intro: "No account wall, no watermark, and no upload step for linked videos. Paste a YouTube link, make your subtitles on top of the video, and download them. Your work is saved in your browser so it's there when you come back.",
    steps: [
      "Paste a YouTube URL.",
      "Play and caption with S to mark in, E to mark out, and type.",
      "Edit any line, then export .srt or .vtt.",
    ],
    faq: [
      ["What's the catch?", "Free covers videos up to 45 minutes, .srt and .vtt export with no watermark, and one translation per video. Solo and Team plans add AI auto-captions, video upload, unlimited translations, and full-length videos, and they fund the free tool."],
      ["Is there a watermark on the file?", "No. The exported .srt and .vtt are clean standard files."],
      ["Where are my subtitles stored?", "In your browser, on your device. If you sign in, they are also saved to your SubCaptions account so they follow you across devices. If you use translation, the caption text is sent to our translation service; the privacy policy has the details."],
    ],
  },
  {
    slug: "subtitle-video-unsupported-language",
    title: "Subtitle a Video in a Language YouTube & Adobe Don't Support",
    h1: "Subtitle a video in any language, even unsupported ones",
    metaDesc: "Auto-captions only cover a shortlist of languages. Caption your video by hand in any language, time it on top of the video, and export .srt. Or hand the link to a translator. Free, no signup.",
    intro: "Automatic captioning from YouTube and Adobe only works for a limited set of languages. If you work in a language they don't support, a regional language, an Indigenous language, a dialect, automation simply isn't an option, and a person has to do it. This is the cheapest, simplest way for that person to caption on top of the video and produce a clean .srt. Do it yourself, or send the video to a translator who knows the language.",
    steps: [
      "Paste your video link (YouTube, Vimeo, Frame.io, Rushes, Dropbox, Google Drive, or a direct file).",
      "Play it and caption each line in your language: mark in and out, type, repeat.",
      "Edit any line, and check it on the video before exporting.",
      "Download the .srt. On a Team plan you can also send a share link so a translator can type the subtitles in their own browser.",
    ],
    faq: [
      ["Which languages does this support?", "Any language you can type. Because a person writes the captions instead of a speech model, there's no supported-language list. If your keyboard can type it, you can caption it, including right-to-left scripts and languages auto-captioning ignores."],
      ["Why can't I just use YouTube or Adobe auto-captions?", "Their automatic captioning is limited to a shortlist of common languages. For anything outside that, it produces nothing usable, so the subtitles have to be written by a person. This tool is built for exactly that."],
      ["Can a translator do this for me?", "Yes. Send them the video link and they can caption it by typing on top of the video, with no software to install. On a Team plan you can instead send a share link to your project, which opens in their browser without an account."],
      ["Do I need to know timecodes?", "No. You mark each line's start and end by pressing a key while the video plays, so the timing comes from the video itself."],
    ],
  },
];

// Use-case / intent pages (not language-pair specific).
export const USE_CASES = [
  {
    slug: "subtitle-translator-for-youtube",
    title: "Subtitle Translator for YouTube",
    h1: "Translate your YouTube subtitles in minutes",
    metaDesc: `Translate your YouTube .srt or .vtt captions into ${LANGUAGE_COUNT} languages, then upload them back to your video. Free for files up to 200 lines, no signup.`,
    intro: "Download your caption file from YouTube Studio, translate it here, and upload the translated track back to your video. To check timing on the real video before you publish, import the translated file into the captioner on the home page, which shows captions on top of the video.",
    steps: [
      "In YouTube Studio, open your video → Subtitles → download the existing caption track (.srt or .vtt).",
      "Drop that file into the translator and pick your target language.",
      "Review the AI translation and fix any line right in the table.",
      "Optional: open the captioner, load your video, and import the translated file to check timing on the real video.",
      "Download the translated file and upload it back in YouTube Studio as a new language.",
    ],
    faq: [
      ["Will this match YouTube's caption format?", "Yes. YouTube accepts both .srt and .vtt, and the translator exports either. Timecodes are preserved exactly, so the translated track stays in sync."],
      ["Does translating captions help non-English viewers?", "Captions in their own language make your existing videos watchable for people who do not speak the original language, without re-recording anything."],
      ["Do I need to re-time anything?", "No. Only the text changes; every start and end time is carried over untouched. Importing the translated file into the captioner lets you confirm the translated lines are short enough to read in the time available."],
    ],
  },
  {
    slug: "translate-subtitles-for-video-editing",
    title: "Translate Subtitles for Video Editing (Premiere, DaVinci, CapCut)",
    h1: "Translate subtitle files for any video editor",
    metaDesc: `Translate .srt and .vtt subtitle files for Premiere Pro, DaVinci Resolve, Final Cut, and CapCut. Keep your timecodes, export clean captions in ${LANGUAGE_COUNT} languages.`,
    intro: "Export your captions from your editor as .srt, translate them here, and import the translated file back. Because timecodes are preserved exactly, the translated subtitles drop straight back onto your timeline.",
    steps: [
      "Export your sequence's captions as an .srt or .vtt from your editor.",
      "Drop the file in, choose your target language, and translate.",
      "Edit any awkward line inline, then export .srt or .vtt.",
      "Re-import the translated file into Premiere, DaVinci, Final Cut, or CapCut.",
    ],
    faq: [
      ["Which editors does this work with?", "Any editor that imports .srt or .vtt, Premiere Pro, DaVinci Resolve, Final Cut Pro, CapCut, Kdenlive, and more. The format is universal."],
      ["Are my timecodes kept?", "Yes, exactly. Only the dialogue text is translated; every timestamp is preserved, so the file re-imports perfectly in sync."],
      ["Can I translate a whole season of files?", "The translator works on one file at a time, up to 200 lines per file. There is no multi-file batch mode."],
    ],
  },
  {
    slug: "free-srt-translator",
    title: "Free SRT Translator (No Signup)",
    h1: "Free SRT translator, no signup, no watermark",
    metaDesc: `A free SRT translator with no account and no watermark. Translate subtitle files into ${LANGUAGE_COUNT} languages. Files up to 200 lines are free.`,
    intro: "Most 'free' subtitle translators put your file behind a signup, a watermark, or a daily wall. This one doesn't. Drop in an .srt, pick a language, and download the result. The file is read in your browser, and only the caption text is sent out for translation.",
    steps: [
      "Drag your .srt file onto the page (or paste the text).",
      "Pick the language you want to translate into.",
      "Download the translated .srt, no account required.",
    ],
    faq: [
      ["What's the catch with 'free'?", "Files up to 200 lines translate free with no signup. Solo and Team plans add unlimited translations, AI auto-captions, and video upload in the captioner on the home page."],
      ["Is my subtitle file uploaded anywhere?", "The file is read in your browser and is not uploaded as a file. The caption text is sent to our translation service, which passes it to Anthropic's API to be translated. Our service does not store or log the text."],
      ["Is there a watermark or line limit on the output?", "There is no watermark. Free files are limited to 200 lines and 2 MB. Longer files need a Solo or Team plan, and the translate page tells you when a file is over the limit."],
    ],
  },
  {
    slug: "vtt-translator",
    title: "VTT Translator, Translate WebVTT Caption Files",
    h1: "Translate .vtt (WebVTT) caption files",
    metaDesc: `Translate WebVTT (.vtt) caption files into ${LANGUAGE_COUNT} languages free. Works with HTML5 video, YouTube, and web players. Convert between SRT and VTT too.`,
    intro: "WebVTT is the caption format for HTML5 `<track>` elements and most web players. Drop your .vtt file in, translate it, and export back to .vtt (or convert to .srt). Cue timings and structure are preserved.",
    steps: [
      "Drop your .vtt file onto the page.",
      "Choose your target language and translate.",
      "Export as .vtt for the web, or as .srt for editors and YouTube.",
    ],
    faq: [
      ["What's the difference between SRT and VTT?", "They're nearly identical caption formats. VTT (WebVTT) is used by HTML5 video and web players; SRT is the universal editor/desktop format. This tool reads and writes both, so it doubles as an SRT↔VTT converter."],
      ["Will styling and cue settings survive?", "The dialogue text and timecodes are preserved. Advanced VTT cue positioning is simplified on export, for standard captions this is exactly what you want."],
      ["Can I translate VTT for a website player?", "Yes. Export the translated .vtt and point your `<track srclang>` at it for each language."],
    ],
  },
];
