<div align="center">

  <img src="assets/brand/app_logo_wordmark.png" alt="CinCin TV" width="300" />

  <h1>CinCin TV (Android & Android TV)</h1>

  <p>
    A rich, kid-friendly multilingual cartoon & movie streaming platform for Android & Android TV — powered by an embedded offline/online catalog of 1,316 series and movies (54,295+ episodes) across English, French, German, Chinese, and Arabic with Dual-Server Failover.
  </p>

</div>

---

## ✨ Key Features

- **1,316 Curated Titles & 54,295+ Episodes Built-In:**
  - **English Series (`720+`) & Movies (`253`)** categorized by **Age Group** (`Ages 1-3`, `Ages 2-5`, `Ages 3-7`, `Ages 5-7`, `Ages 7+`), **Accent** (`American`, `British`, `Australian`, `Canadian`), and **Musical & Educational** themes.
  - **Multilingual Series Rows:** Dedicated rows and filters for **French (`95`)**, **German (`69`)**, **Chinese (`119`)**, and **Arabic (`49`)** cartoons with strict language isolation.
- **Multi-Server Streaming & Automatic Failover (`Main Server` + `Backup Server`):**
  - **`CinCin TV 720p HD (Main Server)`**: Primary high-speed direct MP4 stream.
  - **`CinCin TV 720p HD (Backup Server)`**: Secondary CDN fallback across `7,800+` shared episodes and movies.
  - **`CinCin TV 360p (Data Saver)`**: Low-bandwidth streaming option.
  - Automatic zero-interruption failover if the active CDN server is unreachable, plus manual server switching inside the player's **Sources** panel.
- **Hybrid Online Metadata Enrichment + Instant Offline Fallback:**
  - **When Online:** Automatically fetches high-resolution posters, widescreen backdrops, clear title logos, cast, ratings, and episode thumbnails/synopses from **Nuvio Cinemeta (`v3-cinemeta.strem.io`)**, **Metahub (`metahub.space`)**, and **TMDB**.
  - **When Offline / Restricted Network:** Instantly falls back to the embedded compressed catalog binary without errors or delays, while streaming videos directly from domestic CDN servers (`720p HD` & `360p SD`).
- **Favorites (`♥`), Continue Watching & Cross-Device Sync:**
  - One-click **Favorites** with a red heart icon (`♥`) and a dedicated Favorites tab.
  - Automatic episode & timestamp resume (**Continue Watching**) with next-episode auto-play.
  - Multi-profile support (**Profiles**) and cloud synchronization via **Supabase Account Sync**, **Trakt.tv**, and **Simkl** (automatically mapping internal `hcd:` catalog IDs to their canonical `IMDb` and `TMDB` IDs).

---

## 🛠️ Architecture Overview

- **Built-In Offline/Online Catalog Provider**: Loads the compressed binary catalog asynchronously on `Dispatchers.IO`, exposes 9 structured catalog rows, resolves `720p` (`Main Server` + `Backup Server`) and `360p` direct `.mp4` streams, provides bidirectional ID mapping (`hcd:{id}` ↔ `imdbId` / `tmdbId`), and merges live Cinemeta/TMDB metadata into local items.
- **`AddonPreferences.kt` & `AddonRepositoryImpl.kt`**: Permanently pins the built-in `CinCin TV` system catalog at the top of installed addons, protecting it from accidental removal during remote cloud account synchronization.
- **`MetaRepositoryImpl.kt`**: Orchestrates online metadata enrichment from `https://v3-cinemeta.strem.io` with a `4000ms` timeout, seamless offline fallback, and reverse lookup for `tt...` / `tmdb:...` items synced from Trakt or Simkl.
- **`TmdbService.kt` & `MetaDetailsViewModel.kt`**: Native TMDB enrichment pipeline supporting `hcd:` item IDs for cast, logos, trailers, and episode stills.
- **`TrackingMedia.kt` & `TraktIdUtils.kt`**: Bridges `hcd:` item IDs to external `IMDb` (`tt...`) and `TMDB` IDs so Trakt and Simkl watchlists, favorites, and watch progress sync across devices.

---

## 🔗 Official Repository & Automated Releases

- **GitHub Repository:** [https://github.com/ChosoMeister/CinCinTV](https://github.com/ChosoMeister/CinCinTV)
- **In-App Updater:** Configured with `GITHUB_OWNER = "ChosoMeister"` and `GITHUB_REPO = "CinCinTV"` in `app/build.gradle.kts`.
- **GitHub Actions CI/CD:**
  - **Catalog Builder (`.github/workflows/update-catalog.yml`)**: Automatically compiles the embedded catalog binary when dataset files in `catalog-pipeline/data/` are updated, or when triggered manually via `workflow_dispatch`.
  - **Release APK Builder (`.github/workflows/android-release.yml`)**: Builds and publishes Universal and ABI-split APKs (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) for both **Android** and **Android TV** directly to GitHub Releases.

---

## 🚀 Build & Install from Source

```bash
git clone https://github.com/ChosoMeister/CinCinTV.git
cd CinCinTV

# Build the Debug APK
./gradlew :app:assembleFullDebug

# Install on a connected Android / Android TV device via ADB
adb install -r app/build/outputs/apk/full/debug/app-full-arm64-v8a-debug.apk

# Launch CinCin TV
adb shell am start -n com.nuviodebug.com/com.nuvio.tv.MainActivity
```

Built with **Kotlin**, **Jetpack Compose for TV (Material 3)**, **Hilt**, **Coil**, and **AndroidX Media3 (ExoPlayer)**.

---

## 📄 License

[GNU General Public License v3.0](./LICENSE)
