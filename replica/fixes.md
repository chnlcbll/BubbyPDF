# Fixes: what to build differently from the original

Sample: **683 reviews** (685 collected, 2 duplicates removed) from **3 sources**:
500 App Store reviews (Apple's public RSS feed, 2026-07-16 to 2026-11-08),
50 Google Play reviews (read in the browser, "Most relevant" order, 2018 to 2026),
135 Hacker News comments naming Acrobat (Algolia API, 2024-11 to 2026-10).
548 had star ratings. Trustpilot was not reachable (it served a bot-verification page), so it is not included.

Full ranking with every quote and link: `feedback.md`. Raw rows: `reviews.csv`.

Caveat: the App Store app is mobile (Acrobat Reader for iPhone/iPad); we are building a Windows desktop app.
Themes about pricing, sign-in, upsells and forms carry over; mobile-specific UI complaints do not.

## 1. What they hate

| # | problem | reviews | sources | quote |
|---|---|---|---|---|
| 1 | Basic editing is behind a subscription | 118 | 3 | "they want $15 a month or $70 a year just to be able to edit text in a pdf." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=c1e632ce-79c4-44ec-89ed-d6b1bf885900)) |
| 2 | Free trials that convert to annual plans, cancellation fees, hard to cancel | 60 | 3 | "now I'm stuck paying the 50% cancellation fee" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=5504bccf-7ad3-4cbe-a2fc-4ca664892d1d)) |
| 3 | Forced sign-in and documents pushed to the cloud | 61 | 3 | "my documents don't belong on your servers." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=a1b8e8cb-8a66-4e07-8b77-f420014e7e3c)) |
| 4 | Crashes, freezes, hangs | 45 | 3 | "Locks up after I have just marked up my documents" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=f4c400a3-61bf-4f3c-b365-c7708edbbf43)) |
| 5 | AI assistant pushed into a document reader | 44 | 3 | "Stop with the AI slop!." ([App Store p9](https://itunes.apple.com/us/rss/customerreviews/page=9/id=469337564/sortBy=mostRecent/json)) |
| 6 | Clunky, got worse after redesigns | 34 | 3 | "The version from a few years ago was simpler and worked better." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=d26b8fc6-ec26-4131-9c4c-610c8521936f)) |
| 7 | Fill & sign got worse or moved behind the paywall | 44 | 3 | "we moved field editing behind the pay wall." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=d26a5472-6242-460a-b813-dd9726258764)) |
| 8 | Upsell pop-ups interrupt reading | 29 | 3 | "it interrupted me three times while trying to look at ONE document." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=2ab98ff9-273f-4f40-b8ed-fcb47af7acce)) |
| 9 | Slow and bloated | 26 | 3 | "slower by day. slow start and slow when trying to share." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=d5de24a0-bff0-4428-95c1-2799c83855ac)) |
| 10 | Text editing itself is bad (overlaps, tiny text, cannot resize) | 25 | 3 | "if you add a new line, the layout does not update" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=c1e632ce-79c4-44ec-89ed-d6b1bf885900)) |
| 11 | Lost work and corrupt files after saving | 12 | 3 | "shows damaged and corrupt files after editing" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=178e5b55-bb0d-4b2a-9cab-c47b81f971b9)) |
| 12 | Support that does not answer (thin by count, 5 reviews) | 5 | 3 | "THE CUSTOMER SERVICE IS IMPOSSIBLE" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=44777e1a-ea48-46d9-9e8f-34344ce3c425)) |

## 2. What is missing

| # | request | reviews | sources | quote |
|---|---|---|---|---|
| 1 | Search that works, with a list of all hits | 29 | 3 | "I need an overview of all occurrences of my search term" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=d9188e25-1578-47e0-8c23-2db7eef8996a)) |
| 2 | Back button after following a link | (inside #1) | 1 | "there's no one tap solution to go back." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=9dd2e7bb-8657-44ff-ace3-b84fec463bb2)) |
| 3 | Page tools for free: merge, rotate all, delete, reorder, n-up | 14 | 3 | "You want to rotate the pages and there is no option to select all." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=1352b14a-30c0-445b-ab85-cd10eb8c93e7)) |
| 4 | Undo and a backup before overwriting | (inside hate #10) | 1, thin | "no way to undo them except manually." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=c1e632ce-79c4-44ec-89ed-d6b1bf885900)) |
| 5 | Bigger, resizable check marks and text in forms | (inside hate #7) | 1, thin | "the default is a tiny mark that's barely visible." ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=d26b8fc6-ec26-4131-9c4c-610c8521936f)) |
| 6 | Dark mode for the whole app | 7 | 3, thin by count | "it would also be nice to be able to use night mode in general" ([Play](https://play.google.com/store/apps/details?id=com.adobe.reader&reviewId=ecb97258-b4ba-4ff9-a48d-41f9c9ba19d8)) |

"Convert/export/OCR" (58) and "Platforms" (43) matched many reviews, but by hand most hits are noise
(the word "images" or "windows" inside unrelated reviews). Treat them as unproven.

## 3. What is unsolved

- **People who need to edit, fill or sign one PDF and never want a subscription.** Pricing (118) and billing traps (60)
  are the two biggest themes. Several reviewers say they needed it for one document.
- **People who want their files to stay on their own computer.** Sign-in and cloud complaints (61) across all 3 sources.
- **People who just want a quiet reader.** Upsell pop-ups (29) and AI (44) are complaints about interruption, not features.

## 4. Fix plan

Ranked by evidence times how cheaply we can fix it.

| # | build or change | size | skill | evidence |
|---|---|---|---|---|
| 1 | Every feature free: no plans, no trial, no account, no paywall | S | replica-build, replica-launch | pricing 118, billing 60 |
| 2 | Fully offline desktop app: files never leave the PC, no sign-in, no telemetry | S | replica-architect | cloud/sign-in 61 |
| 3 | Fill & sign for free: form fields, big resizable check marks, drawn or typed signature | M | replica-build | forms 44 |
| 4 | Text tools that do not wreck layout: add text, edit existing text by covering and retyping, resize | M | replica-build | editing 25 |
| 5 | Safe saving: undo/redo, "Save" writes a new copy by default, never overwrites without a backup | S | replica-build | lost work 12, corrupt files |
| 6 | Page tools for free: merge, reorder, rotate all, delete, extract, insert blank | M | replica-build | pages 14 |
| 7 | Search with a full results list and a Back button after jumps | S | replica-build | search/navigation 29 |
| 8 | Zero pop-ups, zero AI, fast start, dark mode | S | replica-design | upsell 29, AI 44, slow 26, dark mode 7 |

## 5. The angle

**A.** For people who need to edit, fill or sign a PDF and refuse to pay a monthly fee for it,
this app does all of it for free, with no account and no trial to cancel.
Evidence: pricing and billing, 178 reviews across 3 sources.

**B.** For people who do not want their documents on someone else's server,
this app runs entirely offline on your PC.
Evidence: sign-in and cloud, 61 reviews across 3 sources.

**C.** For people who just want to read and mark up a PDF in peace,
this app opens fast with no pop-ups, no upsells and no AI assistant.
Evidence: upsell 29, AI 44, slow 26 reviews, each across 3 sources.

**Recommended: A**, with B and C as supporting lines. It is the largest theme by far and it is what the user asked for ("make it free").

Do not put the original's name in the app name, ads or store listing.
