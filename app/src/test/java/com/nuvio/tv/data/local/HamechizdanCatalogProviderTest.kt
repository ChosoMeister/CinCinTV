package com.nuvio.tv.data.local

import android.content.Context
import android.content.res.AssetManager
import io.mockk.every
import io.mockk.mockk
import java.io.ByteArrayInputStream
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HamechizdanCatalogProviderTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `corrupt updated catalog falls back to bundled catalog`() {
        File(temporaryFolder.root, "hamechizdan_catalog_updated.json.gz")
            .writeBytes(ByteArray(2048) { (it % 251).toByte() })

        val context = mockk<Context>()
        val assets = mockk<AssetManager>()
        every { context.filesDir } returns temporaryFolder.root
        every { context.assets } returns assets
        every { assets.list("") } returns arrayOf("hamechizdan_catalog.bin")
        every { assets.open("hamechizdan_catalog.bin") } answers {
            ByteArrayInputStream(
                gzip(
                    """{"version":1,"count":1,"items":[{"id":42,"type":"series","en":"Bundled title"}]}"""
                )
            )
        }

        val provider = HamechizdanCatalogProvider(context)

        assertTrue(provider.hasItem("hcd:42"))
    }

    private fun gzip(value: String): ByteArray {
        val output = ByteArrayOutputStream()
        GZIPOutputStream(output).use { it.write(value.toByteArray(Charsets.UTF_8)) }
        return output.toByteArray()
    }
}
