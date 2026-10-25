package com.nuvio.tv.data.local

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.nuvio.tv.domain.model.Addon
import com.nuvio.tv.domain.model.AddonResource
import com.nuvio.tv.domain.model.CatalogDescriptor
import com.nuvio.tv.domain.model.CatalogExtra
import com.nuvio.tv.domain.model.CatalogRow
import com.nuvio.tv.domain.model.ContentType
import com.nuvio.tv.domain.model.Meta
import com.nuvio.tv.domain.model.MetaBehaviorHints
import com.nuvio.tv.domain.model.MetaPreview
import com.nuvio.tv.domain.model.PosterShape
import com.nuvio.tv.domain.model.Stream
import com.nuvio.tv.domain.model.StreamBadge
import com.nuvio.tv.domain.model.StreamBehaviorHints
import com.nuvio.tv.domain.model.Video
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.util.zip.GZIPInputStream
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.ln1p
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

@Singleton
class HamechizdanCatalogProvider @Inject constructor(
    @param:ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "HamechizdanCatalog"
        const val ADDON_ID = "com.hamechizdan.catalog"
        const val ADDON_NAME = "CinCin TV"
        const val ADDON_BASE_URL = "https://hamechizdan.local"
        const val ID_PREFIX = "hcd:"
        const val PERSONALIZED_CATALOG_ID = "hcd_recommended"
        const val PERSONALIZED_CATALOG_NAME = "Recommended from Favorites"
        private const val PERSONALIZED_RESULT_LIMIT = 40
        private const val ASSET_FILE_NAME = "hamechizdan_catalog.bin"
        private const val LEGACY_ASSET_FILE_NAME = "hamechizdan_catalog.json.gz"
        private const val UNCOMPRESSED_ASSET_FILE_NAME = "hamechizdan_catalog.json"
        private const val CACHED_UPDATE_FILE_NAME = "hamechizdan_catalog_updated.json.gz"
        private const val PAGE_SIZE = 60
        private val AGE_RANGE_REGEX = Regex("(\\d+)\\s*تا\\s*(\\d+)")
        private val AGE_SINGLE_REGEX = Regex("(\\d+)\\s*سال")
        private val LOWERCASE_STOPWORDS = setOf("and", "of", "the", "in", "on", "with", "to", "for", "a", "an")

        @Volatile
        private var staticImdbByHcdKey: Map<String, String> = emptyMap()

        @Volatile
        private var staticTmdbByHcdKey: Map<String, Long> = emptyMap()

        @Volatile
        private var staticInstance: HamechizdanCatalogProvider? = null

        fun isHamechizdanAddon(urlOrId: String?): Boolean {
            if (urlOrId.isNullOrBlank()) return false
            val clean = urlOrId.trim().trimEnd('/').lowercase()
            return clean == ADDON_BASE_URL ||
                clean == ADDON_ID ||
                clean.startsWith("https://hamechizdan.local") ||
                clean.startsWith("hamechizdan://")
        }

        fun isHamechizdanItemId(id: String?): Boolean {
            if (id.isNullOrBlank()) return false
            return id.trim().startsWith(ID_PREFIX, ignoreCase = true)
        }

        fun resolveExternalIdsStatic(rawId: String?): Pair<String?, Long?> {
            if (rawId.isNullOrBlank()) return null to null
            val clean = rawId.trim()
            if (!clean.startsWith(ID_PREFIX, ignoreCase = true)) return null to null
            if (staticImdbByHcdKey.isEmpty()) {
                staticInstance?.ensureLoaded()
            }
            val parts = clean.split(":")
            val baseKey = if (parts.size >= 2) "$ID_PREFIX${parts[1]}".lowercase() else clean.lowercase()
            return staticImdbByHcdKey[baseKey] to staticTmdbByHcdKey[baseKey]
        }

        fun getStreamsStatic(
            type: String?,
            contentId: String?,
            videoId: String?,
            season: Int?,
            episode: Int?
        ): List<Stream> {
            val provider = staticInstance ?: return emptyList()
            val cleanVideoId = videoId?.trim()?.takeIf { it.isNotEmpty() }
            val cleanContentId = contentId?.trim()?.takeIf { it.isNotEmpty() }
            val effectiveType = type?.takeIf { it.isNotBlank() } ?: "series"
            val lookupId = when {
                cleanVideoId != null && cleanVideoId.contains(":") -> cleanVideoId
                cleanContentId != null && season != null && episode != null -> "$cleanContentId:$season:$episode"
                cleanVideoId != null -> cleanVideoId
                cleanContentId != null -> cleanContentId
                else -> return emptyList()
            }
            return provider.getStreams(effectiveType, lookupId)
        }
    }

    data class CompactCatalogBundle(
        @SerializedName("version") val version: Int = 1,
        @SerializedName("count") val count: Int = 0,
        @SerializedName("items") val items: List<CompactItem> = emptyList()
    )

    data class CompactItem(
        @SerializedName("id") val id: Int = 0,
        @SerializedName("type") val type: String = "series",
        @SerializedName("en") val titleEn: String = "",
        @SerializedName("fa") val titleFa: String? = null,
        @SerializedName("lang") val language: String? = null,
        @SerializedName("acc") val accent: String? = null,
        @SerializedName("age") val ageGroup: String? = null,
        @SerializedName("badges") val badges: List<String> = emptyList(),
        @SerializedName("poster") val poster: String? = null,
        @SerializedName("bg") val backdrop: String? = null,
        @SerializedName("thumb") val thumbnail: String? = null,
        @SerializedName("ovFa") val overviewFa: String? = null,
        @SerializedName("ovEn") val overviewEn: String? = null,
        @SerializedName("year") val year: String? = null,
        @SerializedName("rel") val releaseDate: String? = null,
        @SerializedName("rating") val rating: Float? = null,
        @SerializedName("runtime") val runtimeMinutes: Int? = null,
        @SerializedName("imdb") val imdbId: String? = null,
        @SerializedName("tmdbId") val tmdbId: Int? = null,
        @SerializedName("votes") val voteCount: Int? = null,
        @SerializedName("pop") val popularity: Double? = null,
        @SerializedName("genres") val genres: List<String> = emptyList(),
        @SerializedName("eps") val episodes: List<CompactEpisode> = emptyList()
    )

    data class CompactEpisode(
        @SerializedName("id") val id: Int = 0,
        @SerializedName("s") val season: Int = 1,
        @SerializedName("e") val episode: Int = 1,
        @SerializedName("t") val title: String? = null,
        @SerializedName("th") val thumbnail: String? = null,
        @SerializedName("ov") val overview: String? = null,
        @SerializedName("air") val airDate: String? = null,
        @SerializedName("rt") val runtime: Int? = null,
        @SerializedName("u720") val url720: String? = null,
        @SerializedName("s720") val size720: String? = null,
        @SerializedName("u360") val url360: String? = null,
        @SerializedName("s360") val size360: String? = null,
        @SerializedName("uAlt") val urlAlt: String? = null,
        @SerializedName("sAlt") val sizeAlt: String? = null
    )

    private val gson = Gson()
    private val loadLock = Any()
    private val preloadScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var loadedItems: List<CompactItem>? = null

    @Volatile
    private var itemsByHcdId: Map<String, CompactItem> = emptyMap()

    @Volatile
    private var itemsByImdbId: Map<String, CompactItem> = emptyMap()

    @Volatile
    private var itemsByTmdbId: Map<Int, CompactItem> = emptyMap()

    init {
        staticInstance = this
        preloadScope.launch {
            ensureLoaded()
        }
    }

    private fun ensureLoaded(): List<CompactItem> {
        loadedItems?.let { return it }
        synchronized(loadLock) {
            loadedItems?.let { return it }
            val startMs = System.currentTimeMillis()
            val items = try {
                val updatedFile = File(context.filesDir, CACHED_UPDATE_FILE_NAME)
                val updatedItems = if (updatedFile.exists() && updatedFile.length() > 1024) {
                    val parsed = runCatching { readGzipCatalog(updatedFile.inputStream()) }
                        .onFailure { Log.w(TAG, "Updated Hamechizdan catalog is unreadable; using bundled catalog", it) }
                        .getOrNull()
                    if (parsed != null && parsed.isEmpty()) {
                        Log.w(TAG, "Updated Hamechizdan catalog is empty; using bundled catalog")
                    }
                    parsed?.takeIf { it.isNotEmpty() }
                } else {
                    null
                }
                updatedItems ?: loadBundledCatalog()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load Hamechizdan catalog asset", e)
                emptyList()
            }

            val byHcd = LinkedHashMap<String, CompactItem>(items.size)
            val byImdb = LinkedHashMap<String, CompactItem>(items.size)
            val byTmdb = HashMap<Int, CompactItem>(items.size)
            val imdbMap = HashMap<String, String>(items.size)
            val tmdbMap = HashMap<String, Long>(items.size)
            // First pass: index English items by imdbId and tmdbId so multi-language shows (e.g., Peppa Pig)
            // always resolve their canonical IMDb/TMDB ID to the English version.
            for (item in items) {
                val hcdKey = "$ID_PREFIX${item.id}"
                byHcd[hcdKey] = item
                item.imdbId?.trim()?.takeIf { it.startsWith("tt", ignoreCase = true) }?.let { imdb ->
                    imdbMap[hcdKey.lowercase()] = imdb
                }
                item.tmdbId?.takeIf { it > 0 }?.let { tmdb ->
                    tmdbMap[hcdKey.lowercase()] = tmdb.toLong()
                }
                if (item.language == "انگلیسی") {
                    item.imdbId?.takeIf { it.isNotBlank() }?.let { imdb ->
                        byImdb.putIfAbsent(imdb.lowercase(), item)
                    }
                    item.tmdbId?.takeIf { it > 0 }?.let { tmdb ->
                        byTmdb.putIfAbsent(tmdb, item)
                    }
                }
            }
            // Second pass: index remaining items if no English item claimed that imdbId / tmdbId
            for (item in items) {
                item.imdbId?.takeIf { it.isNotBlank() }?.let { imdb ->
                    byImdb.putIfAbsent(imdb.lowercase(), item)
                }
                item.tmdbId?.takeIf { it > 0 }?.let { tmdb ->
                    byTmdb.putIfAbsent(tmdb, item)
                }
            }
            staticImdbByHcdKey = imdbMap
            staticTmdbByHcdKey = tmdbMap
            itemsByHcdId = byHcd
            itemsByImdbId = byImdb
            itemsByTmdbId = byTmdb
            loadedItems = items
            Log.d(TAG, "Loaded ${items.size} Hamechizdan titles in ${System.currentTimeMillis() - startMs}ms")
            return items
        }
    }

    private fun readGzipCatalog(input: InputStream): List<CompactItem> =
        GZIPInputStream(input).use { gzip ->
            InputStreamReader(gzip, Charsets.UTF_8).use { reader ->
                gson.fromJson(reader, CompactCatalogBundle::class.java)?.items.orEmpty()
            }
        }

    private fun loadBundledCatalog(): List<CompactItem> {
        val assetList = context.assets.list("")?.toSet().orEmpty()
        return when {
            ASSET_FILE_NAME in assetList -> readGzipCatalog(context.assets.open(ASSET_FILE_NAME))
            LEGACY_ASSET_FILE_NAME in assetList -> readGzipCatalog(context.assets.open(LEGACY_ASSET_FILE_NAME))
            UNCOMPRESSED_ASSET_FILE_NAME in assetList -> context.assets.open(UNCOMPRESSED_ASSET_FILE_NAME).use { raw ->
                InputStreamReader(raw, Charsets.UTF_8).use { reader ->
                    gson.fromJson(reader, CompactCatalogBundle::class.java)?.items.orEmpty()
                }
            }
            else -> readGzipCatalog(context.assets.open(ASSET_FILE_NAME))
        }
    }

    fun getBuiltinAddon(): Addon {
        val ageGenres = listOf(
            "All Ages",
            "Ages 1-3",
            "Ages 2-5",
            "Ages 3-7",
            "Ages 5-7",
            "Ages 7+"
        )
        val accentGenres = listOf(
            "American Accent",
            "British Accent",
            "Australian Accent"
        )
        val languageOptions = listOf(
            "English",
            "French",
            "German",
            "Arabic",
            "Chinese"
        )
        val englishSeriesExtras = listOf(
            CatalogExtra(name = "search", isRequired = false),
            CatalogExtra(name = "skip", isRequired = false),
            CatalogExtra(name = "genre", isRequired = false, options = ageGenres + accentGenres)
        )
        val otherLangExtras = listOf(
            CatalogExtra(name = "search", isRequired = false),
            CatalogExtra(name = "skip", isRequired = false),
            CatalogExtra(name = "genre", isRequired = false, options = ageGenres)
        )
        val movieExtras = listOf(
            CatalogExtra(name = "search", isRequired = false),
            CatalogExtra(name = "skip", isRequired = false),
            CatalogExtra(name = "genre", isRequired = false, options = languageOptions + ageGenres)
        )

        val catalogs = listOf(
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_all_series",
                name = "All English Series",
                extra = englishSeriesExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = PERSONALIZED_CATALOG_ID,
                name = PERSONALIZED_CATALOG_NAME,
                pageSize = PERSONALIZED_RESULT_LIMIT,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("skip")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_en_toddler",
                name = "English • Toddlers (Ages 1-4)",
                extra = englishSeriesExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_en_kids",
                name = "English • Kids (Ages 5+)",
                extra = englishSeriesExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_en_british",
                name = "English • British Accent",
                extra = englishSeriesExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.MOVIE,
                rawType = "movie",
                id = "hcd_movies",
                name = "Animated Movies",
                extra = movieExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_french",
                name = "French Series (Français)",
                extra = otherLangExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_german",
                name = "German Series (Deutsch)",
                extra = otherLangExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_arabic",
                name = "Arabic Series (العربية)",
                extra = otherLangExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            ),
            CatalogDescriptor(
                type = ContentType.SERIES,
                rawType = "series",
                id = "hcd_chinese",
                name = "Chinese Series (中文)",
                extra = otherLangExtras,
                pageSize = PAGE_SIZE,
                showInHome = true,
                hasExplicitShowInHome = true,
                extraSupported = listOf("search", "skip", "genre")
            )
        )

        return Addon(
            id = ADDON_ID,
            name = ADDON_NAME,
            displayName = ADDON_NAME,
            version = "1.2.0",
            description = "CinCin TV Kids & Family Catalog with 720p HD & 360p Direct Streaming",
            logo = "https://hamechizdan.com/favicon.ico",
            baseUrl = ADDON_BASE_URL,
            catalogs = catalogs,
            types = listOf(ContentType.SERIES, ContentType.MOVIE),
            rawTypes = listOf("series", "movie"),
            resources = listOf(
                AddonResource(
                    name = "catalog",
                    types = listOf("series", "movie"),
                    idPrefixes = listOf(ID_PREFIX, "tt")
                ),
                AddonResource(
                    name = "meta",
                    types = listOf("series", "movie"),
                    idPrefixes = listOf(ID_PREFIX, "tt")
                ),
                AddonResource(
                    name = "stream",
                    types = listOf("series", "movie"),
                    idPrefixes = listOf(ID_PREFIX, "tt")
                )
            ),
            idPrefixes = listOf(ID_PREFIX, "tt"),
            enabled = true
        )
    }

    fun getCatalogRow(
        addonBaseUrl: String,
        addonId: String,
        addonName: String,
        catalogId: String,
        catalogName: String,
        type: String,
        skip: Int,
        skipStep: Int,
        extraArgs: Map<String, String>,
        supportsSkip: Boolean
    ): CatalogRow {
        val allItems = ensureLoaded()
        val searchQuery = extraArgs["search"]?.trim().orEmpty()
        val genreFilter = extraArgs["genre"]?.trim().orEmpty()

        val filteredByCatalog = if (catalogId == PERSONALIZED_CATALOG_ID) {
            buildPersonalizedRecommendations(
                allItems = allItems,
                favoriteIds = parseJsonStringList(extraArgs["favoriteIds"]),
                favoriteNames = parseJsonStringList(extraArgs["favoriteNames"])
            )
        } else if (searchQuery.isNotEmpty()) {
            // Search within each primary language/type catalog separately so English, German, French, etc.
            // are never mixed together in search results!
            val searchableCatalogs = setOf(
                "hcd_all_series",
                "hcd_movies",
                "hcd_french",
                "hcd_german",
                "hcd_arabic",
                "hcd_chinese"
            )
            if (catalogId !in searchableCatalogs) {
                emptyList()
            } else {
                val baseList = filterByCatalogId(allItems, catalogId, type)
                val qLower = searchQuery.lowercase()
                baseList
                    .filter { item -> matchesSearch(item, searchQuery) }
                    .sortedWith(
                        compareBy<CompactItem>(
                            { !it.titleEn.trim().equals(qLower, ignoreCase = true) },
                            { !it.titleEn.trim().lowercase().startsWith(qLower) },
                            { -(it.episodes.size) }
                        )
                    )
            }
        } else {
            filterByCatalogId(allItems, catalogId, type)
        }

        val filteredByGenre = if (genreFilter.isNotEmpty() &&
            !genreFilter.equals("All Ages", ignoreCase = true) &&
            genreFilter != "همه سنین"
        ) {
            filteredByCatalog.filter { item -> matchesGenreFilter(item, genreFilter) }
        } else {
            filteredByCatalog
        }

        val pageSize = if (skipStep > 0) skipStep else PAGE_SIZE
        val pageItems = if (skip >= filteredByGenre.size) {
            emptyList()
        } else {
            filteredByGenre.subList(skip, (skip + pageSize).coerceAtMost(filteredByGenre.size))
        }

        val previews = pageItems.map { it.toMetaPreview(addonBaseUrl) }
        val hasMore = supportsSkip && (skip + pageItems.size) < filteredByGenre.size

        return CatalogRow(
            addonId = addonId,
            addonName = addonName,
            addonBaseUrl = addonBaseUrl,
            catalogId = catalogId,
            catalogName = catalogName,
            type = ContentType.fromString(type),
            rawType = type,
            items = previews,
            isLoading = false,
            hasMore = hasMore,
            currentPage = if (pageSize > 0) skip / pageSize else 0,
            supportsSkip = supportsSkip,
            skipStep = pageSize,
            nextSkip = skip + pageItems.size,
            extraArgs = extraArgs
        )
    }

    fun hasItem(id: String?): Boolean {
        if (id.isNullOrBlank()) return false
        ensureLoaded()
        return resolveItemById(id) != null
    }

    fun getMeta(id: String): Meta? {
        ensureLoaded()
        val item = resolveItemById(id) ?: return null
        return item.toMeta()
    }

    fun getImdbIdForItem(id: String): String? {
        ensureLoaded()
        val item = resolveItemById(id) ?: return null
        return item.imdbId?.trim()?.takeIf { it.startsWith("tt", ignoreCase = true) }
    }

    fun getTmdbIdForItem(id: String): Int? {
        ensureLoaded()
        val item = resolveItemById(id) ?: return null
        return item.tmdbId?.takeIf { it > 0 }
    }

    fun mergeRemoteMetaIntoLocal(localMeta: Meta, remoteMeta: Meta): Meta {
        val isEnglish = localMeta.language.equals("English", ignoreCase = true)

        val remoteVideosByKey = remoteMeta.videos
            .filter { it.season != null && it.episode != null }
            .associateBy { (it.season ?: 1) to (it.episode ?: 1) }

        val mergedVideos = if (localMeta.type == ContentType.MOVIE) {
            val remoteMovieVideo = remoteMeta.videos.firstOrNull()
            localMeta.videos.map { localVideo ->
                localVideo.copy(
                    thumbnail = remoteMovieVideo?.thumbnail?.takeIf { it.isNotBlank() }
                        ?: remoteMeta.backdropUrl?.takeIf { it.isNotBlank() }
                        ?: localVideo.thumbnail,
                    released = localVideo.released ?: remoteMovieVideo?.released ?: remoteMeta.released,
                    runtime = localVideo.runtime ?: remoteMovieVideo?.runtime
                )
            }
        } else {
            localMeta.videos.map { localVideo ->
                val s = localVideo.season ?: 1
                val e = localVideo.episode ?: 1
                val remoteEp = remoteVideosByKey[s to e]
                if (remoteEp == null) {
                    localVideo
                } else {
                    val fileSizeLine = localVideo.overview
                        ?.lines()
                        ?.firstOrNull { it.startsWith("File Size:", ignoreCase = true) }
                    val remoteOv = remoteEp.overview?.trim()?.takeIf { it.isNotBlank() }
                    val mergedOverview = if (isEnglish && remoteOv != null) {
                        if (!fileSizeLine.isNullOrBlank()) "$remoteOv\n$fileSizeLine" else remoteOv
                    } else {
                        localVideo.overview
                    }
                    val remoteTitle = remoteEp.title.trim().takeIf {
                        it.isNotBlank() && !it.startsWith("Episode ", ignoreCase = true)
                    }
                    val mergedTitle = if (isEnglish && remoteTitle != null) {
                        remoteTitle
                    } else {
                        localVideo.title
                    }
                    localVideo.copy(
                        title = mergedTitle,
                        thumbnail = remoteEp.thumbnail?.takeIf { it.isNotBlank() } ?: localVideo.thumbnail,
                        overview = mergedOverview,
                        released = localVideo.released ?: remoteEp.released,
                        runtime = localVideo.runtime ?: remoteEp.runtime,
                        rating = remoteEp.rating ?: localVideo.rating
                    )
                }
            }
        }

        val headerLine = localMeta.description
            ?.lineSequence()
            ?.firstOrNull()
            ?.takeIf { it.contains("•") }
        val remoteDesc = remoteMeta.description?.trim()?.takeIf { it.isNotBlank() }
        val mergedDescription = if (isEnglish && remoteDesc != null) {
            if (!headerLine.isNullOrBlank()) "$headerLine\n\n$remoteDesc" else remoteDesc
        } else {
            localMeta.description
        }

        val mergedGenres = LinkedHashSet<String>().apply {
            addAll(localMeta.genres)
            if (isEnglish) {
                remoteMeta.genres.forEach { g ->
                    if (g.isNotBlank()) add(g.trim())
                }
            }
        }.toList()

        return localMeta.copy(
            poster = remoteMeta.poster?.takeIf { it.isNotBlank() } ?: localMeta.poster,
            background = remoteMeta.background?.takeIf { it.isNotBlank() } ?: localMeta.background,
            logo = remoteMeta.logo?.takeIf { it.isNotBlank() } ?: localMeta.logo,
            landscapePoster = remoteMeta.landscapePoster?.takeIf { it.isNotBlank() }
                ?: remoteMeta.background?.takeIf { it.isNotBlank() }
                ?: localMeta.landscapePoster,
            description = mergedDescription,
            releaseInfo = remoteMeta.releaseInfo?.takeIf { it.isNotBlank() } ?: localMeta.releaseInfo,
            imdbRating = remoteMeta.imdbRating ?: localMeta.imdbRating,
            genres = mergedGenres,
            runtime = localMeta.runtime ?: remoteMeta.runtime,
            director = if (remoteMeta.director.isNotEmpty()) remoteMeta.director else localMeta.director,
            writer = if (remoteMeta.writer.isNotEmpty()) remoteMeta.writer else localMeta.writer,
            cast = if (remoteMeta.cast.isNotEmpty()) remoteMeta.cast else localMeta.cast,
            castMembers = if (remoteMeta.castMembers.isNotEmpty()) remoteMeta.castMembers else localMeta.castMembers,
            videos = mergedVideos,
            productionCompanies = if (remoteMeta.productionCompanies.isNotEmpty()) remoteMeta.productionCompanies else localMeta.productionCompanies,
            networks = if (remoteMeta.networks.isNotEmpty()) remoteMeta.networks else localMeta.networks,
            awards = remoteMeta.awards ?: localMeta.awards,
            links = if (remoteMeta.links.isNotEmpty()) remoteMeta.links else localMeta.links,
            trailerYtIds = if (remoteMeta.trailerYtIds.isNotEmpty()) remoteMeta.trailerYtIds else localMeta.trailerYtIds,
            trailers = if (remoteMeta.trailers.isNotEmpty()) remoteMeta.trailers else localMeta.trailers,
            released = localMeta.released ?: remoteMeta.released
        )
    }

    fun getStreams(type: String, videoId: String): List<Stream> {
        ensureLoaded()
        val cleanId = videoId.trim()
        val parts = cleanId.split(":")

        // Formats supported:
        // 1) hcd:1119:1:2 (series episode S1E2)
        // 2) hcd:1119:44819 (series episode by episode_id)
        // 3) hcd:1119 (movie or default first episode)
        // 4) tt21971750:1:2 or tt21971750
        val baseId = when {
            cleanId.startsWith(ID_PREFIX, ignoreCase = true) && parts.size >= 2 -> "$ID_PREFIX${parts[1]}"
            cleanId.startsWith("tt", ignoreCase = true) -> parts[0]
            else -> cleanId
        }

        val item = resolveItemById(baseId) ?: return emptyList()
        if (item.episodes.isEmpty()) return emptyList()

        val targetEpisode: CompactEpisode = when {
            // hcd:{id}:{season}:{episode}
            cleanId.startsWith(ID_PREFIX, ignoreCase = true) && parts.size >= 4 -> {
                val s = parts[2].toIntOrNull() ?: 1
                val e = parts[3].toIntOrNull() ?: 1
                item.episodes.firstOrNull { it.season == s && it.episode == e }
                    ?: item.episodes.firstOrNull { it.episode == e }
                    ?: item.episodes.first()
            }
            // hcd:{id}:{episodeId}
            cleanId.startsWith(ID_PREFIX, ignoreCase = true) && parts.size == 3 -> {
                val epIdOrNum = parts[2].toIntOrNull()
                item.episodes.firstOrNull { it.id == epIdOrNum }
                    ?: item.episodes.firstOrNull { it.episode == epIdOrNum }
                    ?: item.episodes.first()
            }
            // tt1234567:{season}:{episode}
            cleanId.startsWith("tt", ignoreCase = true) && parts.size >= 3 -> {
                val s = parts[1].toIntOrNull() ?: 1
                val e = parts[2].toIntOrNull() ?: 1
                item.episodes.firstOrNull { it.season == s && it.episode == e }
                    ?: item.episodes.firstOrNull { it.episode == e }
                    ?: item.episodes.first()
            }
            else -> item.episodes.first()
        }

        return buildStreamsForEpisode(item, targetEpisode)
    }

    private fun resolveItemById(id: String): CompactItem? {
        val clean = id.trim()
        if (clean.startsWith("tmdb:", ignoreCase = true)) {
            val tmdbNum = clean.substringAfter(':').substringBefore(':').toIntOrNull()
            if (tmdbNum != null) {
                itemsByTmdbId[tmdbNum]?.let { return it }
            }
        }
        val directKey = when {
            clean.startsWith(ID_PREFIX, ignoreCase = true) -> {
                val parts = clean.split(":")
                if (parts.size >= 2) "$ID_PREFIX${parts[1]}" else clean.lowercase()
            }
            clean.startsWith("imdb:", ignoreCase = true) -> {
                clean.substringAfter(':').substringBefore(':').lowercase()
            }
            else -> clean.substringBefore(":").lowercase()
        }
        itemsByHcdId[directKey]?.let { return it }
        itemsByImdbId[directKey]?.let { return it }
        val numeric = directKey.removePrefix(ID_PREFIX).toIntOrNull()
        if (numeric != null) {
            itemsByHcdId["$ID_PREFIX$numeric"]?.let { return it }
        }
        return null
    }

    private fun filterByCatalogId(
        items: List<CompactItem>,
        catalogId: String,
        type: String
    ): List<CompactItem> {
        val toddlerAges = setOf(
            "0 تا 2 سال",
            "1 تا 2 سال",
            "1 تا 3 سال",
            "1 تا 4 سال",
            "1 تا 5 سال",
            "2 تا 3 سال",
            "2 تا 4 سال",
            "2 تا 5 سال",
            "2 تا 6 سال",
            "2 تا 7 سال",
            "3 تا 4 سال",
            "3 تا 5 سال"
        )
        return when (catalogId) {
            "hcd_movies" -> sortByRatingAndPopularity(
                items.filter { it.type.equals("movie", ignoreCase = true) }
            )
            "hcd_en_toddler" -> items
                .filter { item ->
                    item.type.equals("series", ignoreCase = true) &&
                        item.language == "انگلیسی" &&
                        (item.ageGroup in toddlerAges ||
                            item.badges.any { it.contains("1 تا ") || it.contains("2 تا ") })
                }
                .let(::sortByRatingAndPopularity)
            "hcd_en_kids" -> items
                .filter { item ->
                    item.type.equals("series", ignoreCase = true) &&
                        item.language == "انگلیسی" &&
                        item.ageGroup !in toddlerAges
                }
                .let(::sortByRatingAndPopularity)
            "hcd_en_british" -> items
                .filter { item ->
                    item.type.equals("series", ignoreCase = true) &&
                        item.language == "انگلیسی" &&
                        item.accent == "لهجه بریتانیایی"
                }
                .let(::sortByRatingAndPopularity)
            "hcd_french" -> items
                .filter { it.language == "فرانسوی" }
                .let(::sortByRatingAndPopularity)
            "hcd_german" -> items
                .filter { it.language == "آلمانی" }
                .let(::sortByRatingAndPopularity)
            "hcd_arabic" -> items
                .filter { it.language == "عربی" }
                .let(::sortByRatingAndPopularity)
            "hcd_chinese" -> items
                .filter { it.language == "چینی" }
                .let(::sortByRatingAndPopularity)
            "hcd_all_series" -> items
                .filter { it.type.equals("series", ignoreCase = true) && it.language == "انگلیسی" }
                .let(::sortByRatingAndPopularity)
            else -> items.filter { it.type.equals(type, ignoreCase = true) }
        }
    }

    private fun parseJsonStringList(value: String?): List<String> {
        if (value.isNullOrBlank()) return emptyList()
        return runCatching { gson.fromJson(value, Array<String>::class.java)?.toList().orEmpty() }
            .getOrDefault(emptyList())
            .map(String::trim)
            .filter(String::isNotEmpty)
    }

    /**
     * Build a profile-specific discovery row. Favorites are resolved against the bundled catalog
     * by HCD/IMDb/TMDB ID first and by an exact normalized title as a fallback. Unrated items are
     * retained only when needed to reach 40 and always rank after rated titles.
     */
    private fun buildPersonalizedRecommendations(
        allItems: List<CompactItem>,
        favoriteIds: List<String>,
        favoriteNames: List<String>
    ): List<CompactItem> {
        val favoriteNameKeys = favoriteNames.mapTo(hashSetOf(), ::normalizedTitle)
        val favoriteItems = LinkedHashSet<CompactItem>()
        favoriteIds.forEach { id -> resolveItemById(id)?.let(favoriteItems::add) }
        if (favoriteNameKeys.isNotEmpty()) {
            allItems.filterTo(favoriteItems) { normalizedTitle(it.titleEn) in favoriteNameKeys }
        }
        if (favoriteItems.isEmpty()) return emptyList()

        val favoriteIdsCanonical = favoriteItems.mapTo(hashSetOf(), ::canonicalRecommendationKey)
        val excludedNames = favoriteNameKeys + favoriteItems.map { normalizedTitle(it.titleEn) }
        val candidates = allItems.asSequence()
            .filter { it.type.equals("series", ignoreCase = true) && it.language == "انگلیسی" }
            .filterNot { canonicalRecommendationKey(it) in favoriteIdsCanonical }
            .filterNot { normalizedTitle(it.titleEn) in excludedNames }
            .distinctBy(::canonicalRecommendationKey)
            .toList()
        if (candidates.isEmpty()) return emptyList()

        val favoriteTopicCounts = mutableMapOf<String, Int>()
        favoriteItems.forEach { favorite ->
            recommendationTopics(favorite).forEach { topic ->
                favoriteTopicCounts[topic] = (favoriteTopicCounts[topic] ?: 0) + 1
            }
        }
        val totalTopicWeight = favoriteTopicCounts.values.sum().coerceAtLeast(1)
        val favoriteAgeRanges = favoriteItems.mapNotNull(::recommendationAgeRange)
        val preferredAccent = favoriteItems.mapNotNull { it.accent?.takeIf(String::isNotBlank) }
            .groupingBy { it }
            .eachCount()
            .maxByOrNull { it.value }
            ?.key

        val maxLogPopularity = candidates.maxOfOrNull { item ->
            ln1p(item.popularity?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0)
        } ?: 0.0

        fun score(item: CompactItem): Double {
            val itemTopics = recommendationTopics(item)
            val topicFit = if (favoriteTopicCounts.isEmpty() || itemTopics.isEmpty()) {
                0.0
            } else {
                itemTopics.sumOf { (favoriteTopicCounts[it] ?: 0).toDouble() } / totalTopicWeight
            }.coerceIn(0.0, 1.0)
            val ageRange = recommendationAgeRange(item)
            val ageFit = when {
                favoriteAgeRanges.isEmpty() || ageRange == null -> 0.5
                favoriteAgeRanges.any { (min, max) -> ageRange.first <= max && ageRange.second >= min } -> 1.0
                else -> 0.0
            }
            val accentFit = if (preferredAccent != null && item.accent == preferredAccent) 1.0 else 0.0
            val rating = item.rating?.takeIf { it.isFinite() && it > 0f }?.toDouble()
            val votes = item.voteCount?.coerceAtLeast(0) ?: 0
            val trustedRating = rating?.let { (it * votes + 6.5 * 30.0) / (votes + 30.0) } ?: 0.0
            val popularity = item.popularity?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0
            val popularityFit = if (maxLogPopularity > 0.0) ln1p(popularity) / maxLogPopularity else 0.0

            // Favorites drive discovery; age fit protects the child-oriented audience while
            // rating confidence and popularity help order otherwise similar suggestions.
            return (topicFit * 0.45) + (ageFit * 0.20) + (accentFit * 0.05) +
                ((trustedRating / 10.0) * 0.22) + (popularityFit * 0.08)
        }

        return candidates.sortedWith(
            compareByDescending<CompactItem> { it.rating?.takeIf { value -> value.isFinite() && value > 0f } != null }
                .thenByDescending(::score)
                .thenByDescending { it.rating?.takeIf { value -> value.isFinite() && value > 0f } ?: Float.NEGATIVE_INFINITY }
                .thenByDescending { it.popularity?.takeIf { value -> value.isFinite() && value > 0.0 } ?: 0.0 }
                .thenBy { it.titleEn.lowercase() }
        ).take(PERSONALIZED_RESULT_LIMIT)
    }

    private fun canonicalRecommendationKey(item: CompactItem): String = when {
        item.tmdbId != null && item.tmdbId > 0 -> "tmdb:${item.tmdbId}"
        !item.imdbId.isNullOrBlank() -> "imdb:${item.imdbId.trim().lowercase()}"
        else -> "title:${normalizedTitle(item.titleEn)}"
    }

    private fun normalizedTitle(title: String): String = title
        .lowercase()
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim()
        .replace(Regex("\\s+"), " ")

    private fun recommendationTopics(item: CompactItem): Set<String> {
        val text = buildString {
            append(item.titleEn).append(' ')
            append(item.overviewEn.orEmpty()).append(' ')
            append(item.genres.joinToString(" "))
        }.lowercase()
        val topicKeywords = mapOf(
            "math" to listOf("math", "number", "count", "counting", "shape", "geometry", "addition", "subtract", "measure", "pattern"),
            "science" to listOf("science", "experiment", "discovery", "discover", "space", "planet", "technology", "invent", "engineering"),
            "nature" to listOf("animal", "wildlife", "ocean", "sea", "nature", "environment", "forest", "zoo", "habitat", "earth"),
            "literacy" to listOf("word", "letter", "reading", "read", "story", "book", "spelling", "language", "vocabulary"),
            "social" to listOf("friend", "friendship", "family", "emotion", "feel", "share", "kindness", "community", "school", "everyday"),
            "problem_solving" to listOf("solve", "problem", "mystery", "puzzle", "clue", "rescue", "mission", "teamwork"),
            "music" to listOf("music", "song", "sing", "dance", "rhythm", "instrument")
        )
        val textWords = text.split(Regex("[^a-z0-9]+")).toHashSet()
        return topicKeywords.mapNotNullTo(linkedSetOf()) { (topic, words) ->
            topic.takeIf { words.any(textWords::contains) }
        }
    }

    private fun recommendationAgeRange(item: CompactItem): Pair<Int, Int>? {
        val age = item.ageGroup ?: return null
        val match = AGE_RANGE_REGEX.find(age) ?: return null
        val start = match.groupValues[1].toIntOrNull() ?: return null
        val end = match.groupValues[2].toIntOrNull() ?: return null
        return minOf(start, end) to maxOf(start, end)
    }

    /**
     * Keep unrated titles at the end. For rated titles, blend a vote-count-smoothed
     * rating (85%) with logarithmically normalized TMDB popularity (15%).
     * Episode count is only a stable tie-breaker, not a substitute for popularity.
     */
    private fun sortByRatingAndPopularity(items: List<CompactItem>): List<CompactItem> {
        if (items.size < 2) return items

        val maxLogPopularity = items.maxOfOrNull { item ->
            ln1p(item.popularity?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0)
        } ?: 0.0

        fun rating(item: CompactItem): Double? =
            item.rating?.takeIf { it.isFinite() && it > 0f }?.toDouble()

        fun popularity(item: CompactItem): Double =
            item.popularity?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0

        fun combinedScore(item: CompactItem): Double? {
            val rating = rating(item) ?: return null
            val votes = item.voteCount?.coerceAtLeast(0) ?: 0
            val smoothedRating = if (votes > 0) {
                (rating * votes + 6.5 * 30.0) / (votes + 30.0)
            } else {
                rating
            }
            val popularityScore = if (maxLogPopularity > 0.0) {
                10.0 * ln1p(popularity(item)) / maxLogPopularity
            } else {
                0.0
            }
            return smoothedRating * 0.85 + popularityScore * 0.15
        }

        return items.sortedWith(
            compareByDescending<CompactItem> { rating(it) != null }
                .thenByDescending { combinedScore(it) ?: Double.NEGATIVE_INFINITY }
                .thenByDescending { rating(it) ?: Double.NEGATIVE_INFINITY }
                .thenByDescending { popularity(it) }
                .thenByDescending { it.episodes.size }
                .thenBy { it.titleEn.lowercase() }
        )
    }

    private fun matchesGenreFilter(item: CompactItem, genreFilter: String): Boolean {
        val g = genreFilter.trim()
        val langEn = translateLanguageToEn(item.language)
        val ageEn = translateAgeToEn(item.ageGroup)
        val accEn = translateAccentToEn(item.accent)
        return when {
            g.equals("English", ignoreCase = true) -> item.language == "انگلیسی"
            g.equals("French", ignoreCase = true) -> item.language == "فرانسوی"
            g.equals("German", ignoreCase = true) -> item.language == "آلمانی"
            g.equals("Arabic", ignoreCase = true) -> item.language == "عربی"
            g.equals("Chinese", ignoreCase = true) -> item.language == "چینی"
            g.equals("American Accent", ignoreCase = true) -> item.accent == "لهجه آمریکایی"
            g.equals("British Accent", ignoreCase = true) -> item.accent == "لهجه بریتانیایی"
            g.equals("Australian Accent", ignoreCase = true) -> item.accent == "لهجه استرالیایی"
            g.equals("Ages 1-3", ignoreCase = true) -> item.ageGroup in setOf("0 تا 2 سال", "1 تا 2 سال", "1 تا 3 سال", "1 تا 4 سال", "2 تا 3 سال", "2 تا 4 سال")
            g.equals("Ages 2-5", ignoreCase = true) -> item.ageGroup in setOf("1 تا 4 سال", "1 تا 5 سال", "2 تا 4 سال", "2 تا 5 سال", "2 تا 6 سال", "3 تا 5 سال", "3 تا 6 سال")
            g.equals("Ages 3-7", ignoreCase = true) -> item.ageGroup in setOf("2 تا 6 سال", "2 تا 7 سال", "3 تا 6 سال", "3 تا 7 سال", "4 تا 7 سال")
            g.equals("Ages 5-7", ignoreCase = true) -> item.ageGroup in setOf("4 تا 7 سال", "5 تا 7 سال", "6 تا 7 سال")
            g.equals("Ages 7+", ignoreCase = true) -> item.ageGroup in setOf("5 تا 7 سال", "6 تا 7 سال", "7 سال")
            else -> {
                langEn?.equals(g, ignoreCase = true) == true ||
                    ageEn?.equals(g, ignoreCase = true) == true ||
                    accEn?.equals(g, ignoreCase = true) == true ||
                    item.language == g ||
                    item.ageGroup == g ||
                    item.genres.any { it.equals(g, ignoreCase = true) }
            }
        }
    }

    private fun matchesSearch(item: CompactItem, query: String): Boolean {
        val q = query.lowercase()
        val langEn = translateLanguageToEn(item.language)?.lowercase().orEmpty()
        return item.titleEn.lowercase().contains(q) ||
            (item.titleFa?.lowercase()?.contains(q) == true) ||
            (item.language?.lowercase()?.contains(q) == true) ||
            langEn.contains(q)
    }

    private fun translateLanguageToEn(lang: String?): String? {
        if (lang.isNullOrBlank()) return null
        return when (lang.trim()) {
            "انگلیسی" -> "English"
            "فرانسوی" -> "French"
            "آلمانی" -> "German"
            "عربی" -> "Arabic"
            "چینی" -> "Chinese"
            else -> null
        }
    }

    private fun translateAccentToEn(acc: String?): String? {
        if (acc.isNullOrBlank()) return null
        return when {
            acc.contains("آمریکایی") -> "American Accent"
            acc.contains("بریتانیایی") -> "British Accent"
            acc.contains("استرالیایی") -> "Australian Accent"
            acc.contains("ایرلندی") -> "Irish Accent"
            acc.contains("نیوزلندی") -> "New Zealand Accent"
            else -> null
        }
    }

    private fun translateAgeToEn(age: String?): String? {
        if (age.isNullOrBlank()) return null
        AGE_RANGE_REGEX.find(age)?.let { match ->
            return "Ages ${match.groupValues[1]}-${match.groupValues[2]}"
        }
        AGE_SINGLE_REGEX.find(age)?.let { match ->
            return "Ages ${match.groupValues[1]}+"
        }
        return null
    }

    private fun containsPersianChars(text: String?): Boolean {
        if (text.isNullOrBlank()) return false
        return text.any { ch -> ch in '\u0600'..'\u06FF' || ch in '\u0750'..'\u077F' || ch in '\uFB50'..'\uFDFF' || ch in '\uFE70'..'\uFEFF' }
    }

    private fun CompactItem.displayTitle(): String {
        val rawEn = titleEn.trim()
        // Normalize lowercase words in common titles like "Peppa pig" -> "Peppa Pig"
        val cleanEn = if (rawEn.isNotEmpty()) {
            rawEn.split(" ").joinToString(" ") { word ->
                if (word.isNotEmpty() && word[0].isLowerCase() && word.lowercase() !in LOWERCASE_STOPWORDS) {
                    word.replaceFirstChar { it.uppercaseChar() }
                } else {
                    word
                }
            }
        } else {
            "Item #$id"
        }
        val langEn = translateLanguageToEn(language)
        return if (langEn != null && langEn != "English" && !cleanEn.contains(langEn, ignoreCase = true)) {
            "$cleanEn [$langEn]"
        } else {
            cleanEn
        }
    }

    private fun CompactItem.combinedDescription(): String {
        val cleanOvEn = overviewEn?.trim()?.takeIf { it.isNotEmpty() && !containsPersianChars(it) }
        val metaLine = buildList {
            translateLanguageToEn(language)?.let { add(it) }
            translateAccentToEn(accent)?.let { add(it) }
            translateAgeToEn(ageGroup)?.let { add(it) }
            if (episodes.isNotEmpty() && type.equals("series", ignoreCase = true)) {
                add("${episodes.size} Episodes")
            }
        }.joinToString(" • ")

        if (cleanOvEn != null) {
            return if (metaLine.isNotEmpty()) "$metaLine\n\n$cleanOvEn" else cleanOvEn
        }

        val fallback = buildString {
            append(displayTitle())
            append(" is an educational ")
            append(translateLanguageToEn(language) ?: "English")
            append(if (type.equals("movie", ignoreCase = true)) " animated movie" else " animated series")
            translateAgeToEn(ageGroup)?.let { append(" designed for ").append(it) }
            translateAccentToEn(accent)?.let { append(" (").append(it).append(")") }
            append(".")
        }
        return if (metaLine.isNotEmpty()) "$metaLine\n\n$fallback" else fallback
    }

    private fun CompactItem.combinedGenres(): List<String> {
        val list = LinkedHashSet<String>()
        translateLanguageToEn(language)?.let { list.add(it) }
        translateAgeToEn(ageGroup)?.let { list.add(it) }
        translateAccentToEn(accent)?.let { list.add(it) }
        genres.forEach { g ->
            val trimmed = g.trim()
            if (trimmed.isNotBlank() && !containsPersianChars(trimmed)) {
                list.add(trimmed)
            }
        }
        return list.toList()
    }

    private fun CompactItem.effectiveImdbId(): String? {
        return imdbId?.trim()?.takeIf { it.startsWith("tt", ignoreCase = true) }
    }

    private fun CompactItem.preferredPosterUrl(): String? {
        val localPoster = poster ?: thumbnail
        if (!localPoster.isNullOrBlank() && !localPoster.contains("hamechizdan.com/storage", ignoreCase = true)) {
            return localPoster
        }
        val imdb = effectiveImdbId()
        return if (imdb != null) {
            "https://images.metahub.space/poster/medium/$imdb/img"
        } else {
            localPoster
        }
    }

    private fun CompactItem.preferredBackdropUrl(): String? {
        val localBg = backdrop ?: thumbnail ?: poster
        if (!backdrop.isNullOrBlank() && !backdrop.contains("hamechizdan.com/storage", ignoreCase = true)) {
            return backdrop
        }
        val imdb = effectiveImdbId()
        return if (imdb != null) {
            "https://images.metahub.space/background/medium/$imdb/img"
        } else {
            localBg
        }
    }

    private fun CompactItem.preferredLogoUrl(): String? {
        val imdb = effectiveImdbId() ?: return null
        return "https://images.metahub.space/logo/medium/$imdb/img"
    }

    private fun CompactItem.preferredEpisodeThumbnailUrl(ep: CompactEpisode, sNum: Int, eNum: Int): String? {
        val localEpThumb = ep.thumbnail
        if (!localEpThumb.isNullOrBlank() && !localEpThumb.contains("hamechizdan.com/storage", ignoreCase = true)) {
            return localEpThumb
        }
        val imdb = effectiveImdbId()
        return if (imdb != null) {
            "https://episodes.metahub.space/$imdb/$sNum/$eNum/w780.jpg"
        } else {
            localEpThumb ?: thumbnail ?: backdrop ?: poster
        }
    }

    private fun CompactItem.toMetaPreview(addonBaseUrl: String): MetaPreview {
        val contentType = if (type.equals("movie", ignoreCase = true)) ContentType.MOVIE else ContentType.SERIES
        val itemId = "$ID_PREFIX$id"
        val seasonCount = if (contentType == ContentType.SERIES) {
            episodes.map { it.season }.distinct().size.coerceAtLeast(1)
        } else null
        val ageEn = translateAgeToEn(ageGroup)
        val langEn = translateLanguageToEn(language)

        return MetaPreview(
            id = itemId,
            type = contentType,
            rawType = contentType.toApiString(),
            name = displayTitle(),
            poster = preferredPosterUrl(),
            posterShape = PosterShape.POSTER,
            background = preferredBackdropUrl(),
            logo = preferredLogoUrl(),
            description = combinedDescription(),
            releaseInfo = year ?: ageEn ?: langEn,
            imdbRating = rating?.takeIf { it > 0f },
            genres = combinedGenres(),
            runtime = runtimeMinutes?.takeIf { it > 0 }?.let { "$it min" },
            ageRating = ageEn,
            language = langEn,
            released = releaseDate,
            imdbId = effectiveImdbId(),
            landscapePoster = preferredBackdropUrl(),
            seasonCount = seasonCount,
            sourceAddonBaseUrl = addonBaseUrl
        )
    }

    private fun CompactItem.toMeta(): Meta {
        val contentType = if (type.equals("movie", ignoreCase = true)) ContentType.MOVIE else ContentType.SERIES
        val itemId = "$ID_PREFIX$id"
        val ageEn = translateAgeToEn(ageGroup)
        val langEn = translateLanguageToEn(language)
        val accEn = translateAccentToEn(accent)

        val videoList = if (contentType == ContentType.MOVIE) {
            val firstEp = episodes.firstOrNull()
            if (firstEp != null) {
                val cleanEpOv = firstEp.overview?.takeIf { it.isNotBlank() && !containsPersianChars(it) }
                listOf(
                    Video(
                        id = itemId,
                        title = displayTitle(),
                        released = releaseDate ?: firstEp.airDate,
                        thumbnail = firstEp.thumbnail ?: backdrop ?: thumbnail ?: poster,
                        streams = buildStreamsForEpisode(this, firstEp),
                        season = null,
                        episode = null,
                        overview = cleanEpOv ?: combinedDescription(),
                        runtime = firstEp.runtime ?: runtimeMinutes,
                        available = true
                    )
                )
            } else emptyList()
        } else {
            episodes.mapIndexed { index, ep ->
                val sNum = ep.season.takeIf { it > 0 } ?: 1
                val eNum = ep.episode.takeIf { it > 0 } ?: (index + 1)
                val videoId = "$itemId:$sNum:$eNum"
                val sizeInfo = listOfNotNull(
                    ep.size720?.takeIf { !containsPersianChars(it) }?.let { "720p: $it" },
                    ep.size360?.takeIf { !containsPersianChars(it) }?.let { "360p: $it" }
                ).joinToString(" | ")
                val cleanEpOv = ep.overview?.trim()?.takeIf { it.isNotEmpty() && !containsPersianChars(it) }
                val epOverview = buildString {
                    if (cleanEpOv != null) {
                        append(cleanEpOv)
                    }
                    if (sizeInfo.isNotEmpty()) {
                        if (isNotEmpty()) append("\n")
                        append("File Size: ").append(sizeInfo)
                    }
                }.ifBlank { combinedDescription() }

                val cleanEpTitle = ep.title?.trim()?.takeIf { it.isNotEmpty() && !containsPersianChars(it) }
                    ?: "Episode $eNum"

                Video(
                    id = videoId,
                    title = cleanEpTitle,
                    released = ep.airDate ?: releaseDate,
                    thumbnail = preferredEpisodeThumbnailUrl(ep, sNum, eNum),
                    streams = buildStreamsForEpisode(this, ep),
                    season = sNum,
                    episode = eNum,
                    overview = epOverview,
                    runtime = ep.runtime ?: runtimeMinutes,
                    available = true
                )
            }
        }

        val defaultVideoId = if (contentType == ContentType.MOVIE) itemId else null

        return Meta(
            id = itemId,
            type = contentType,
            rawType = contentType.toApiString(),
            name = displayTitle(),
            poster = preferredPosterUrl(),
            posterShape = PosterShape.POSTER,
            background = preferredBackdropUrl(),
            logo = preferredLogoUrl(),
            description = combinedDescription(),
            releaseInfo = year ?: ageEn ?: langEn,
            status = if (contentType == ContentType.SERIES) "${episodes.size} Episodes" else "Movie",
            imdbRating = rating?.takeIf { it > 0f },
            genres = combinedGenres(),
            runtime = runtimeMinutes?.takeIf { it > 0 }?.let { "$it min" },
            director = emptyList(),
            writer = emptyList(),
            cast = emptyList(),
            videos = videoList,
            ageRating = ageEn,
            country = accEn,
            awards = null,
            language = langEn,
            links = emptyList(),
            imdbId = effectiveImdbId(),
            released = releaseDate,
            landscapePoster = preferredBackdropUrl(),
            behaviorHints = MetaBehaviorHints(
                defaultVideoId = defaultVideoId,
                hasScheduledVideos = false
            )
        )
    }

    private fun buildStreamsForEpisode(item: CompactItem, ep: CompactEpisode): List<Stream> {
        val result = mutableListOf<Stream>()
        val langBadge = translateLanguageToEn(item.language) ?: "English"
        val cleanEpTitle = ep.title?.trim()?.takeIf { it.isNotEmpty() && !containsPersianChars(it) }
            ?: item.displayTitle()

        // 1) Primary HD Stream (First stream for auto-play)
        ep.url720?.takeIf { it.isNotBlank() }?.let { url720 ->
            val sizeLabel = ep.size720?.takeIf { it.isNotBlank() && !containsPersianChars(it) } ?: "HD"
            val is480 = url720.contains(".480p.", ignoreCase = true) || url720.contains("/480p/", ignoreCase = true)
            val qLabel = if (is480) "480p" else "720p"
            val qBadge = if (is480) "480p SD" else "720p HD"
            val qVal = if (is480) 480 else 720
            val hasBackup = !ep.urlAlt.isNullOrBlank() && ep.urlAlt != url720
            val streamName = if (hasBackup) "CinCin TV $qBadge (Main Server)" else "CinCin TV $qBadge"
            result.add(
                Stream(
                    name = streamName,
                    title = "$cleanEpTitle • $qBadge",
                    description = "Direct $qBadge • Size: $sizeLabel • Audio: $langBadge",
                    url = url720,
                    ytId = null,
                    infoHash = null,
                    fileIdx = null,
                    externalUrl = null,
                    behaviorHints = StreamBehaviorHints(
                        notWebReady = false,
                        bingeGroup = "hamechizdan-720p",
                        countryWhitelist = null,
                        proxyHeaders = null,
                        filename = url720.substringAfterLast('/')
                    ),
                    addonName = ADDON_NAME,
                    addonLogo = "https://hamechizdan.com/favicon.ico",
                    quality = qLabel,
                    qualityValue = qVal,
                    badges = listOfNotNull(
                        StreamBadge(name = qBadge),
                        ep.size720?.takeIf { !containsPersianChars(it) }?.let { StreamBadge(name = it) }
                    )
                )
            )
        }

        // 2) Backup HD/SD Stream (Automatic failover + selectable in player)
        ep.urlAlt?.takeIf { it.isNotBlank() && it != ep.url720 }?.let { urlAlt ->
            val sizeLabel = ep.sizeAlt?.takeIf { it.isNotBlank() && !containsPersianChars(it) } ?: "HD"
            val is480 = urlAlt.contains(".480p.", ignoreCase = true) || urlAlt.contains("/480p/", ignoreCase = true)
            val qLabel = if (is480) "480p" else "720p"
            val qBadge = if (is480) "480p SD" else "720p HD"
            val qVal = if (is480) 480 else 720
            result.add(
                Stream(
                    name = "CinCin TV $qBadge (Backup Server)",
                    title = "$cleanEpTitle • $qBadge (Backup)",
                    description = "Backup Server $qBadge • Size: $sizeLabel • Audio: $langBadge",
                    url = urlAlt,
                    ytId = null,
                    infoHash = null,
                    fileIdx = null,
                    externalUrl = null,
                    behaviorHints = StreamBehaviorHints(
                        notWebReady = false,
                        bingeGroup = "hamechizdan-backup",
                        countryWhitelist = null,
                        proxyHeaders = null,
                        filename = urlAlt.substringAfterLast('/')
                    ),
                    addonName = ADDON_NAME,
                    addonLogo = "https://hamechizdan.com/favicon.ico",
                    quality = qLabel,
                    qualityValue = qVal,
                    badges = listOfNotNull(
                        StreamBadge(name = "Backup"),
                        StreamBadge(name = qBadge),
                        ep.sizeAlt?.takeIf { !containsPersianChars(it) }?.let { StreamBadge(name = it) }
                    )
                )
            )
        }

        // 3) 360p Low-Data Stream (Selectable in player / source selector)
        ep.url360?.takeIf { it.isNotBlank() }?.let { url360 ->
            val sizeLabel = ep.size360?.takeIf { it.isNotBlank() && !containsPersianChars(it) } ?: "Data Saver"
            result.add(
                Stream(
                    name = "CinCin TV 360p (Data Saver)",
                    title = "$cleanEpTitle • 360p SD",
                    description = "Direct 360p (Low Data) • Size: $sizeLabel • Audio: $langBadge",
                    url = url360,
                    ytId = null,
                    infoHash = null,
                    fileIdx = null,
                    externalUrl = null,
                    behaviorHints = StreamBehaviorHints(
                        notWebReady = false,
                        bingeGroup = "hamechizdan-360p",
                        countryWhitelist = null,
                        proxyHeaders = null,
                        filename = url360.substringAfterLast('/')
                    ),
                    addonName = ADDON_NAME,
                    addonLogo = "https://hamechizdan.com/favicon.ico",
                    quality = "360p",
                    qualityValue = 360,
                    badges = listOfNotNull(
                        StreamBadge(name = "360p"),
                        ep.size360?.takeIf { !containsPersianChars(it) }?.let { StreamBadge(name = it) }
                    )
                )
            )
        }

        return result
    }
}
