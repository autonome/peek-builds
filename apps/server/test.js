const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Use test directory for all databases
const TEST_DATA_DIR = path.join(__dirname, "test-data");
process.env.DATA_DIR = TEST_DATA_DIR;

const TEST_USER_ID = "testuser";

// Clean up test directory before tests
function cleanTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true });
  }
}

cleanTestDir();

describe("Database Tests", () => {
  let db;

  beforeEach(() => {
    // Fresh db module for each test
    delete require.cache[require.resolve("./db")];
    cleanTestDir();
    db = require("./db");
  });

  after(() => {
    if (db && db.closeAllConnections) {
      db.closeAllConnections();
    }
    cleanTestDir();
  });

  describe("saveUrl", () => {
    it("should save a URL without tags", () => {
      const id = db.saveUrl(TEST_USER_ID, "https://example.com");
      assert.ok(id, "should return an id");
      assert.match(id, /^[0-9a-f-]{36}$/, "id should be a UUID");
    });

    it("should save a URL with tags", () => {
      const id = db.saveUrl(TEST_USER_ID, "https://example.com", ["test", "demo"]);
      assert.ok(id);

      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.strictEqual(urls.length, 1);
      assert.strictEqual(urls[0].url, "https://example.com");
      assert.deepStrictEqual(urls[0].tags.sort(), ["demo", "test"]);
    });

    it("should update existing URL instead of duplicating", () => {
      const id1 = db.saveUrl(TEST_USER_ID, "https://example.com", ["tag1"]);
      const id2 = db.saveUrl(TEST_USER_ID, "https://example.com", ["tag2"]);

      // Should reuse same ID
      assert.strictEqual(id1, id2);

      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.strictEqual(urls.length, 1);
      // Tags should be replaced
      assert.deepStrictEqual(urls[0].tags, ["tag2"]);
    });

    it("should save multiple different URLs", () => {
      db.saveUrl(TEST_USER_ID, "https://example1.com");
      db.saveUrl(TEST_USER_ID, "https://example2.com");
      db.saveUrl(TEST_USER_ID, "https://example3.com");

      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.strictEqual(urls.length, 3);
    });
  });

  describe("getSavedUrls", () => {
    it("should return empty array when no URLs", () => {
      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.deepStrictEqual(urls, []);
    });

    it("should return all saved URLs", () => {
      db.saveUrl(TEST_USER_ID, "https://first.com");
      db.saveUrl(TEST_USER_ID, "https://second.com");
      db.saveUrl(TEST_USER_ID, "https://third.com");

      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.strictEqual(urls.length, 3);
      const urlStrings = urls.map((u) => u.url).sort();
      assert.deepStrictEqual(urlStrings, [
        "https://first.com",
        "https://second.com",
        "https://third.com",
      ]);
    });

    it("should include savedAt timestamp", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      const urls = db.getSavedUrls(TEST_USER_ID);

      assert.ok(urls[0].savedAt);
      // Should be a number (Unix ms)
      assert.strictEqual(typeof urls[0].savedAt, "number");
    });
  });

  describe("deleteUrl", () => {
    it("should delete a URL by id", () => {
      const id = db.saveUrl(TEST_USER_ID, "https://example.com");
      assert.strictEqual(db.getSavedUrls(TEST_USER_ID).length, 1);

      db.deleteUrl(TEST_USER_ID, id);
      assert.strictEqual(db.getSavedUrls(TEST_USER_ID).length, 0);
    });

    it("should cascade delete url_tags associations", () => {
      const id = db.saveUrl(TEST_USER_ID, "https://example.com", ["tag1", "tag2"]);
      db.deleteUrl(TEST_USER_ID, id);

      // URL should be gone
      assert.strictEqual(db.getSavedUrls(TEST_USER_ID).length, 0);

      // Tags should still exist (not deleted with URL)
      const tags = db.getTagsByFrecency(TEST_USER_ID);
      assert.strictEqual(tags.length, 2);
    });

    it("should not error when deleting non-existent id", () => {
      assert.doesNotThrow(() => {
        db.deleteUrl(TEST_USER_ID, "non-existent-id");
      });
    });
  });

  describe("updateUrlTags", () => {
    it("should update tags for existing URL", () => {
      const id = db.saveUrl(TEST_USER_ID, "https://example.com", ["old-tag"]);
      db.updateUrlTags(TEST_USER_ID, id, ["new-tag1", "new-tag2"]);

      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.deepStrictEqual(urls[0].tags.sort(), ["new-tag1", "new-tag2"]);
    });

    it("should clear tags when given empty array", () => {
      const id = db.saveUrl(TEST_USER_ID, "https://example.com", ["tag1", "tag2"]);
      db.updateUrlTags(TEST_USER_ID, id, []);

      const urls = db.getSavedUrls(TEST_USER_ID);
      assert.deepStrictEqual(urls[0].tags, []);
    });
  });

  describe("Tags and Frecency", () => {
    it("should track tag frequency", () => {
      db.saveUrl(TEST_USER_ID, "https://example1.com", ["common"]);
      db.saveUrl(TEST_USER_ID, "https://example2.com", ["common"]);
      db.saveUrl(TEST_USER_ID, "https://example3.com", ["common"]);
      db.saveUrl(TEST_USER_ID, "https://example4.com", ["rare"]);

      const tags = db.getTagsByFrecency(TEST_USER_ID);
      const common = tags.find((t) => t.name === "common");
      const rare = tags.find((t) => t.name === "rare");

      assert.strictEqual(common.frequency, 3);
      assert.strictEqual(rare.frequency, 1);
    });

    it("should sort tags by frecency score descending", () => {
      db.saveUrl(TEST_USER_ID, "https://example1.com", ["rare"]);
      db.saveUrl(TEST_USER_ID, "https://example2.com", ["common"]);
      db.saveUrl(TEST_USER_ID, "https://example3.com", ["common"]);
      db.saveUrl(TEST_USER_ID, "https://example4.com", ["common"]);

      const tags = db.getTagsByFrecency(TEST_USER_ID);
      assert.strictEqual(tags[0].name, "common");
      assert.strictEqual(tags[1].name, "rare");
    });

    it("should have positive frecency score", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com", ["test"]);
      const tags = db.getTagsByFrecency(TEST_USER_ID);

      assert.ok(tags[0].frecencyScore > 0);
    });

    it("should return empty array when no tags", () => {
      const tags = db.getTagsByFrecency(TEST_USER_ID);
      assert.deepStrictEqual(tags, []);
    });
  });

  describe("Tag Metadata Sync (saveTags/getTagsSince)", () => {
    it("upserts a new tag's color, description, and metadata by name", () => {
      const { saved, total } = db.saveTags(TEST_USER_ID, "default", [
        { name: "work", color: "#ff0000", description: "Work stuff", metadata: { icon: "briefcase" }, createdAt: 1000, updatedAt: 1000 },
      ]);
      assert.strictEqual(total, 1);
      assert.strictEqual(saved, 1);

      const tags = db.getTagsSince(TEST_USER_ID, "default", 0);
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, "work");
      assert.strictEqual(tags[0].color, "#ff0000");
      assert.strictEqual(tags[0].description, "Work stuff");
      assert.deepStrictEqual(tags[0].metadata, { icon: "briefcase" });
    });

    it("carries parentId as a plain string (the parent's name), not any id", () => {
      db.saveTags(TEST_USER_ID, "default", [
        { name: "parent", createdAt: 1000, updatedAt: 1000 },
        { name: "child", parentId: "parent", createdAt: 1000, updatedAt: 1000 },
      ]);
      const tags = db.getTagsSince(TEST_USER_ID, "default", 0);
      const child = tags.find((t) => t.name === "child");
      assert.strictEqual(child.parentId, "parent");
    });

    it("last-write-wins: an older push does not overwrite a newer existing tag", () => {
      db.saveTags(TEST_USER_ID, "default", [
        { name: "notes", color: "#00ff00", createdAt: 1000, updatedAt: 5000 },
      ]);
      const { saved } = db.saveTags(TEST_USER_ID, "default", [
        { name: "notes", color: "#ff0000", createdAt: 1000, updatedAt: 2000 },
      ]);
      assert.strictEqual(saved, 0, "an older updatedAt must not be counted as saved");

      const tags = db.getTagsSince(TEST_USER_ID, "default", 0);
      assert.strictEqual(tags.find((t) => t.name === "notes").color, "#00ff00");
    });

    it("getTagsSince returns only tags updated after the given timestamp", () => {
      db.saveTags(TEST_USER_ID, "default", [
        { name: "old", createdAt: 1000, updatedAt: 1000 },
        { name: "new", createdAt: 5000, updatedAt: 5000 },
      ]);
      const sinceMid = db.getTagsSince(TEST_USER_ID, "default", 3000);
      assert.strictEqual(sinceMid.length, 1);
      assert.strictEqual(sinceMid[0].name, "new");
    });

    it("an item push that derives a tag row does not wipe metadata already on that row", () => {
      db.saveTags(TEST_USER_ID, "default", [
        { name: "project", color: "#123456", description: "A real description", metadata: { hierarchy: "root" }, createdAt: 1000, updatedAt: 1000 },
      ]);

      // saveUrl tags the item with the same name, exercising getOrCreateTagWithConn()
      // on a row that already carries metadata — this is the main way this feature
      // could lose data.
      db.saveUrl(TEST_USER_ID, "https://example.com", ["project"]);

      const tags = db.getTagsSince(TEST_USER_ID, "default", 0);
      const tag = tags.find((t) => t.name === "project");
      assert.strictEqual(tag.color, "#123456", "color must survive an item push referencing this tag");
      assert.strictEqual(tag.description, "A real description");
      assert.deepStrictEqual(tag.metadata, { hierarchy: "root" });

      // The item push still did its own job — frequency incremented.
      const byFrecency = db.getTagsByFrecency(TEST_USER_ID, "default");
      assert.strictEqual(byFrecency.find((t) => t.name === "project").frequency, 1);
    });
  });

  describe("Settings", () => {
    it("should save and retrieve settings", () => {
      db.setSetting(TEST_USER_ID, "test_key", "test_value");
      const value = db.getSetting(TEST_USER_ID, "test_key");
      assert.strictEqual(value, "test_value");
    });

    it("should return null for non-existent setting", () => {
      const value = db.getSetting(TEST_USER_ID, "non_existent");
      assert.strictEqual(value, null);
    });

    it("should update existing setting", () => {
      db.setSetting(TEST_USER_ID, "key", "value1");
      db.setSetting(TEST_USER_ID, "key", "value2");

      const value = db.getSetting(TEST_USER_ID, "key");
      assert.strictEqual(value, "value2");
    });
  });

  describe("saveText", () => {
    it("should save a text without tags", () => {
      const id = db.saveText(TEST_USER_ID, "My note content");
      assert.ok(id, "should return an id");
      assert.match(id, /^[0-9a-f-]{36}$/, "id should be a UUID");
    });

    it("should save a text with tags", () => {
      const id = db.saveText(TEST_USER_ID, "My note", ["personal", "todo"]);
      assert.ok(id);

      const texts = db.getTexts(TEST_USER_ID);
      assert.strictEqual(texts.length, 1);
      assert.strictEqual(texts[0].content, "My note");
      assert.deepStrictEqual(texts[0].tags.sort(), ["personal", "todo"]);
    });

    it("should update existing text with same content", () => {
      const id1 = db.saveText(TEST_USER_ID, "Same content", ["tag1"]);
      const id2 = db.saveText(TEST_USER_ID, "Same content", ["tag2"]);

      assert.strictEqual(id1, id2);
      const texts = db.getTexts(TEST_USER_ID);
      assert.strictEqual(texts.length, 1);
      assert.deepStrictEqual(texts[0].tags, ["tag2"]);
    });
  });

  describe("saveTagset", () => {
    it("should save a tagset", () => {
      const id = db.saveTagset(TEST_USER_ID, ["pushups", "10"]);
      assert.ok(id, "should return an id");
      assert.match(id, /^[0-9a-f-]{36}$/, "id should be a UUID");
    });

    it("should deduplicate tagsets with same tags", () => {
      const id1 = db.saveTagset(TEST_USER_ID, ["pushups", "10"]);
      const id2 = db.saveTagset(TEST_USER_ID, ["pushups", "10"]);

      // Tagsets with identical tag sets are deduplicated
      assert.strictEqual(id1, id2);

      const tagsets = db.getTagsets(TEST_USER_ID);
      assert.strictEqual(tagsets.length, 1);
    });

    it("should retrieve tagsets with their tags", () => {
      db.saveTagset(TEST_USER_ID, ["exercise", "pushups", "20"]);

      const tagsets = db.getTagsets(TEST_USER_ID);
      assert.strictEqual(tagsets.length, 1);
      assert.deepStrictEqual(tagsets[0].tags.sort(), ["20", "exercise", "pushups"]);
    });
  });

  describe("getItems (unified)", () => {
    it("should return all items when no type filter", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      db.saveText(TEST_USER_ID, "A note");
      db.saveTagset(TEST_USER_ID, ["tag1", "tag2"]);

      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 3);
    });

    it("should filter items by type", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      db.saveText(TEST_USER_ID, "A note");
      db.saveTagset(TEST_USER_ID, ["tag1"]);

      const urls = db.getItems(TEST_USER_ID, "url");
      assert.strictEqual(urls.length, 1);
      assert.strictEqual(urls[0].type, "url");

      const texts = db.getItems(TEST_USER_ID, "text");
      assert.strictEqual(texts.length, 1);
      assert.strictEqual(texts[0].type, "text");

      const tagsets = db.getItems(TEST_USER_ID, "tagset");
      assert.strictEqual(tagsets.length, 1);
      assert.strictEqual(tagsets[0].type, "tagset");
    });

    it("should filter items by a list of types (type IN ...)", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      db.saveText(TEST_USER_ID, "A note");
      db.saveTagset(TEST_USER_ID, ["tag1"]);
      db.saveItem(TEST_USER_ID, "entity", null, ["entity:person"], { name: "Ada" });

      // A client that syncs url+text gets only those, never the entity.
      const synced = db.getItems(TEST_USER_ID, ["url", "text"]);
      assert.strictEqual(synced.length, 2);
      assert.ok(synced.every((i) => i.type === "url" || i.type === "text"));
      assert.ok(!synced.some((i) => i.type === "entity"));

      // A single-element list behaves like the scalar form.
      assert.strictEqual(db.getItems(TEST_USER_ID, ["entity"]).length, 1);
    });
  });

  describe("getItemsSince (type list)", () => {
    it("should filter incremental pulls by a list of types", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      db.saveText(TEST_USER_ID, "A note");
      db.saveItem(TEST_USER_ID, "entity", null, ["entity:person"], { name: "Ada" });

      // since=0 returns everything updated after epoch; the type list still excludes entity.
      const synced = db.getItemsSince(TEST_USER_ID, 0, ["url", "text"], "default");
      assert.ok(synced.length >= 2);
      assert.ok(!synced.some((i) => i.type === "entity"));
    });
  });

  describe("deleteItem", () => {
    it("should soft-delete any item type", () => {
      const urlId = db.saveUrl(TEST_USER_ID, "https://example.com");
      const textId = db.saveText(TEST_USER_ID, "Note");
      const tagsetId = db.saveTagset(TEST_USER_ID, ["tag"]);

      assert.strictEqual(db.getItems(TEST_USER_ID).length, 3);

      db.deleteItem(TEST_USER_ID, urlId);
      assert.strictEqual(db.getItems(TEST_USER_ID).length, 2);

      db.deleteItem(TEST_USER_ID, textId);
      assert.strictEqual(db.getItems(TEST_USER_ID).length, 1);

      db.deleteItem(TEST_USER_ID, tagsetId);
      assert.strictEqual(db.getItems(TEST_USER_ID).length, 0);
    });

    it("should retain soft-deleted items in database with includeDeleted", () => {
      const urlId = db.saveUrl(TEST_USER_ID, "https://example.com");
      db.deleteItem(TEST_USER_ID, urlId);

      // Default query excludes deleted items
      assert.strictEqual(db.getItems(TEST_USER_ID).length, 0);

      // includeDeleted should show them
      const allItems = db.getItems(TEST_USER_ID, null, "default", true);
      assert.strictEqual(allItems.length, 1);
      assert.ok(allItems[0].deletedAt > 0, "deletedAt should be set");
    });
  });

  describe("updateItemTags", () => {
    it("should update tags for any item type", () => {
      const textId = db.saveText(TEST_USER_ID, "Note", ["old"]);
      db.updateItemTags(TEST_USER_ID, textId, ["new1", "new2"]);

      const texts = db.getTexts(TEST_USER_ID);
      assert.deepStrictEqual(texts[0].tags.sort(), ["new1", "new2"]);
    });
  });

  describe("Multi-user isolation", () => {
    it("should isolate data between users", () => {
      const user1 = "user1";
      const user2 = "user2";

      db.saveUrl(user1, "https://user1.com", ["user1-tag"]);
      db.saveUrl(user2, "https://user2.com", ["user2-tag"]);

      const urls1 = db.getSavedUrls(user1);
      const urls2 = db.getSavedUrls(user2);

      assert.strictEqual(urls1.length, 1);
      assert.strictEqual(urls1[0].url, "https://user1.com");

      assert.strictEqual(urls2.length, 1);
      assert.strictEqual(urls2[0].url, "https://user2.com");
    });
  });

  describe("saveImage", () => {
    // Create a simple 1x1 PNG image buffer for testing
    const testPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it("should save an image and return id", () => {
      const id = db.saveImage(TEST_USER_ID, "test.png", testPngBuffer, "image/png");
      assert.ok(id, "should return an id");
      assert.match(id, /^[0-9a-f-]{36}$/, "id should be a UUID");
    });

    it("should save an image with tags", () => {
      const id = db.saveImage(TEST_USER_ID, "photo.png", testPngBuffer, "image/png", ["photo", "test"]);
      assert.ok(id);

      const images = db.getImages(TEST_USER_ID);
      assert.strictEqual(images.length, 1);
      assert.strictEqual(images[0].filename, "photo.png");
      assert.deepStrictEqual(images[0].tags.sort(), ["photo", "test"]);
    });

    it("should store file on disk", () => {
      db.saveImage(TEST_USER_ID, "disk.png", testPngBuffer, "image/png");
      const imagesDir = path.join(TEST_DATA_DIR, TEST_USER_ID, "profiles", "default", "images");
      const files = fs.readdirSync(imagesDir);
      assert.strictEqual(files.length, 1);
      assert.ok(files[0].endsWith(".png"));
    });

    it("should deduplicate identical images", () => {
      const id1 = db.saveImage(TEST_USER_ID, "first.png", testPngBuffer, "image/png");
      const id2 = db.saveImage(TEST_USER_ID, "second.png", testPngBuffer, "image/png");

      // Should create two different item records
      assert.notStrictEqual(id1, id2);

      // But only one file on disk
      const imagesDir = path.join(TEST_DATA_DIR, TEST_USER_ID, "profiles", "default", "images");
      const files = fs.readdirSync(imagesDir);
      assert.strictEqual(files.length, 1);
    });

    it("should reject non-image MIME types", () => {
      assert.throws(
        () => db.saveImage(TEST_USER_ID, "file.txt", Buffer.from("text"), "text/plain"),
        /must be an image/
      );
    });

    it("should reject images over size limit", () => {
      const largeBuffer = Buffer.alloc(db.MAX_IMAGE_SIZE + 1);
      assert.throws(
        () => db.saveImage(TEST_USER_ID, "large.png", largeBuffer, "image/png"),
        /exceeds maximum size/
      );
    });

    it("should store metadata correctly", () => {
      db.saveImage(TEST_USER_ID, "meta.png", testPngBuffer, "image/png");
      const images = db.getImages(TEST_USER_ID);

      assert.strictEqual(images[0].mime, "image/png");
      assert.strictEqual(images[0].size, testPngBuffer.length);
    });
  });

  describe("getImages", () => {
    const testPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it("should return empty array when no images", () => {
      const images = db.getImages(TEST_USER_ID);
      assert.deepStrictEqual(images, []);
    });

    it("should return all images with metadata", () => {
      db.saveImage(TEST_USER_ID, "img1.png", testPngBuffer, "image/png", ["tag1"]);
      db.saveImage(TEST_USER_ID, "img2.png", Buffer.from(testPngBuffer), "image/png", ["tag2"]);

      const images = db.getImages(TEST_USER_ID);
      assert.strictEqual(images.length, 2);
      assert.ok(images[0].id);
      assert.ok(images[0].filename);
      assert.ok(images[0].mime);
      assert.ok(images[0].size);
      assert.ok(images[0].createdAt);
      assert.ok(Array.isArray(images[0].tags));
    });
  });

  describe("getImageById", () => {
    const testPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it("should return image by id", () => {
      const id = db.saveImage(TEST_USER_ID, "find.png", testPngBuffer, "image/png");
      const image = db.getImageById(TEST_USER_ID, id);

      assert.ok(image);
      assert.strictEqual(image.id, id);
      assert.strictEqual(image.filename, "find.png");
      assert.ok(image.metadata.hash);
    });

    it("should return null for non-existent id", () => {
      const image = db.getImageById(TEST_USER_ID, "non-existent");
      assert.strictEqual(image, null);
    });
  });

  describe("getImagePath", () => {
    const testPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it("should return valid file path", () => {
      const id = db.saveImage(TEST_USER_ID, "path.png", testPngBuffer, "image/png");
      const imagePath = db.getImagePath(TEST_USER_ID, id);

      assert.ok(imagePath);
      assert.ok(fs.existsSync(imagePath));
    });

    it("should return null for non-existent id", () => {
      const imagePath = db.getImagePath(TEST_USER_ID, "non-existent");
      assert.strictEqual(imagePath, null);
    });
  });

  describe("deleteImage", () => {
    const testPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it("should soft-delete image record", () => {
      const id = db.saveImage(TEST_USER_ID, "del.png", testPngBuffer, "image/png");
      assert.strictEqual(db.getImages(TEST_USER_ID).length, 1);

      db.deleteImage(TEST_USER_ID, id);
      // Image should not appear in default query (soft-deleted)
      assert.strictEqual(db.getImages(TEST_USER_ID).length, 0);
    });

    it("should keep file on disk after soft-delete (tombstone for sync)", () => {
      const id = db.saveImage(TEST_USER_ID, "single.png", testPngBuffer, "image/png");
      const imagePath = db.getImagePath(TEST_USER_ID, id);
      assert.ok(fs.existsSync(imagePath));

      db.deleteImage(TEST_USER_ID, id);
      // File stays on disk — soft-delete preserves the row and file
      assert.ok(fs.existsSync(imagePath), "file should remain after soft-delete");
    });

    it("should retain soft-deleted image in database", () => {
      const id = db.saveImage(TEST_USER_ID, "retained.png", testPngBuffer, "image/png");
      db.deleteImage(TEST_USER_ID, id);

      // Should still exist with includeDeleted
      const allItems = db.getItems(TEST_USER_ID, "image", "default", true);
      assert.strictEqual(allItems.length, 1);
      assert.ok(allItems[0].deletedAt > 0, "deletedAt should be set");
    });
  });

  describe("getItems with images", () => {
    const testPngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    it("should include images in getItems", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      db.saveText(TEST_USER_ID, "Note");
      db.saveImage(TEST_USER_ID, "pic.png", testPngBuffer, "image/png");

      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 3);

      const imageItem = items.find((i) => i.type === "image");
      assert.ok(imageItem);
      assert.ok(imageItem.metadata);
      assert.strictEqual(imageItem.metadata.mime, "image/png");
    });

    it("should filter by image type", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      db.saveImage(TEST_USER_ID, "pic.png", testPngBuffer, "image/png");

      const images = db.getItems(TEST_USER_ID, "image");
      assert.strictEqual(images.length, 1);
      assert.strictEqual(images[0].type, "image");
    });
  });

  describe("Unified Item Types", () => {
    it("should support url, text, tagset, image types", () => {
      const urlId = db.saveUrl(TEST_USER_ID, "https://example.com");
      const textId = db.saveText(TEST_USER_ID, "My note");
      const tagsetId = db.saveTagset(TEST_USER_ID, ["tag1", "tag2"]);

      const items = db.getItems(TEST_USER_ID);
      const types = items.map((i) => i.type).sort();
      assert.deepStrictEqual(types, ["tagset", "text", "url"]);
    });

    it("should save items with correct type values", () => {
      const urlId = db.saveItem(TEST_USER_ID, "url", "https://test.com", ["web"]);
      const textId = db.saveItem(TEST_USER_ID, "text", "Note content", ["note"]);
      const tagsetId = db.saveItem(TEST_USER_ID, "tagset", null, ["exercise", "20"]);

      const items = db.getItems(TEST_USER_ID);
      const urlItem = items.find((i) => i.id === urlId);
      const textItem = items.find((i) => i.id === textId);
      const tagsetItem = items.find((i) => i.id === tagsetId);

      assert.strictEqual(urlItem.type, "url");
      assert.strictEqual(textItem.type, "text");
      assert.strictEqual(tagsetItem.type, "tagset");
    });
  });

  describe("Sync Columns Schema", () => {
    it("should have sync columns in schema", () => {
      const conn = db.getConnection(TEST_USER_ID);
      const tableInfo = conn.all("PRAGMA table_info(items)");
      const columnNames = tableInfo.map((col) => col.name);

      assert.ok(columnNames.includes("syncId"), "should have syncId column");
      assert.ok(columnNames.includes("syncedAt"), "should have syncedAt column");
    });

    it("should have sync_id index", () => {
      const conn = db.getConnection(TEST_USER_ID);
      const indexes = conn.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items'");
      const indexNames = indexes.map((idx) => idx.name);

      assert.ok(indexNames.includes("idx_items_syncId"), "should have idx_items_syncId index");
    });
  });

  describe("Snake-case Migration", () => {
    it("should migrate snake_case item_tags columns to camelCase", () => {
      // Simulate a legacy database with snake_case columns
      const { DatabaseSync } = require("node:sqlite");
      const legacyDir = path.join(TEST_DATA_DIR, "legacy-user", "profiles", "default");
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyDb = new DatabaseSync(path.join(legacyDir, "datastore.sqlite"));
      legacyDb.exec("PRAGMA journal_mode = WAL");

      // Create legacy schema with snake_case columns
      legacyDb.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT,
          metadata TEXT,
          sync_id TEXT DEFAULT '',
          sync_source TEXT DEFAULT '',
          synced_at INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER DEFAULT 0
        );
        CREATE TABLE tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          frequency INTEGER DEFAULT 1,
          last_used_at INTEGER NOT NULL,
          frecency_score REAL DEFAULT 0.0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE item_tags (
          item_id TEXT NOT NULL,
          tag_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (item_id, tag_id)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);

      // Insert a legacy item
      legacyDb.prepare(`
        INSERT INTO items (id, type, content, sync_id, sync_source, synced_at, created_at, updated_at, deleted_at)
        VALUES ('legacy-1', 'url', 'https://example.com', '', '', 0, 1000, 1000, 0)
      `).run();
      legacyDb.close();

      // Now open via db module — initializeSchema should migrate columns
      delete require.cache[require.resolve("./db")];
      const freshDb = require("./db");
      const conn = freshDb.getConnection("legacy-user");

      // Verify columns were renamed
      const itemCols = conn.all("PRAGMA table_info(items)").map(c => c.name);
      assert.ok(itemCols.includes("syncId"), "items.sync_id should be renamed to syncId");
      assert.ok(itemCols.includes("createdAt"), "items.created_at should be renamed to createdAt");
      assert.ok(itemCols.includes("deletedAt"), "items.deleted_at should be renamed to deletedAt");
      assert.ok(!itemCols.includes("sync_id"), "items should not have snake_case sync_id");

      const tagCols = conn.all("PRAGMA table_info(tags)").map(c => c.name);
      assert.ok(tagCols.includes("lastUsed"), "tags.last_used_at should be renamed to lastUsed");
      assert.ok(tagCols.includes("frecencyScore"), "tags.frecency_score should be renamed to frecencyScore");

      const itCols = conn.all("PRAGMA table_info(item_tags)").map(c => c.name);
      assert.ok(itCols.includes("itemId"), "item_tags.item_id should be renamed to itemId");
      assert.ok(itCols.includes("tagId"), "item_tags.tag_id should be renamed to tagId");

      // Verify the legacy data is still accessible
      const items = freshDb.getItems("legacy-user");
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].content, "https://example.com");

      freshDb.closeAllConnections();
    });
  });

  describe("Production Schema Migration", () => {
    it("should migrate original production schema to canonical (INTEGER PK, last_used, TEXT timestamps)", () => {
      // This tests the ACTUAL production database schema from commit 21c30add5839.
      // Key differences from canonical:
      // - tags.id: INTEGER PRIMARY KEY AUTOINCREMENT (not TEXT)
      // - tags column: last_used (not last_used_at or lastUsed)
      // - item_tags.tag_id: INTEGER (not TEXT)
      // - All timestamps: TEXT (not INTEGER)
      // - items.deleted_at: NULL means not deleted (not 0)
      const { DatabaseSync } = require("node:sqlite");
      const rbDir = path.join(TEST_DATA_DIR, "rebuild-user", "profiles", "default");
      fs.mkdirSync(rbDir, { recursive: true });
      const rbDb = new DatabaseSync(path.join(rbDir, "datastore.sqlite"));
      rbDb.exec("PRAGMA journal_mode = WAL");

      rbDb.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('url', 'text', 'tagset', 'image')),
          content TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE TABLE tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          frequency INTEGER NOT NULL DEFAULT 0,
          last_used TEXT NOT NULL,
          frecency_score REAL NOT NULL DEFAULT 0.0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE item_tags (
          item_id TEXT NOT NULL,
          tag_id INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (item_id, tag_id),
          FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
        CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
        CREATE INDEX IF NOT EXISTS idx_tags_frecency ON tags(frecency_score DESC);
      `);

      // Insert test data with original TEXT timestamps and NULL deleted_at
      const ts = new Date("2026-01-15T10:00:00Z").toISOString();
      rbDb.prepare(`
        INSERT INTO items (id, type, content, created_at, updated_at, deleted_at)
        VALUES ('rb-1', 'url', 'https://example.com', ?, ?, NULL)
      `).run(ts, ts);
      rbDb.prepare(`
        INSERT INTO tags (name, frequency, last_used, frecency_score, created_at, updated_at)
        VALUES ('test', 3, ?, 15.0, ?, ?)
      `).run(ts, ts, ts);
      rbDb.prepare(`
        INSERT INTO item_tags (item_id, tag_id, created_at) VALUES ('rb-1', 1, ?)
      `).run(ts);
      rbDb.close();

      // Open via db module — ALTER RENAME will fail, rebuild should kick in
      delete require.cache[require.resolve("./db")];
      const freshDb = require("./db");
      const conn = freshDb.getConnection("rebuild-user");

      // Verify all columns are camelCase after rebuild
      const itemCols = new Set(conn.all("PRAGMA table_info(items)").map(c => c.name));
      assert.ok(itemCols.has("createdAt"), "items should have createdAt");
      assert.ok(itemCols.has("deletedAt"), "items should have deletedAt");
      assert.ok(itemCols.has("syncId"), "items should have syncId");

      const tagCols = new Set(conn.all("PRAGMA table_info(tags)").map(c => c.name));
      assert.ok(tagCols.has("lastUsed"), "tags should have lastUsed (was last_used)");
      assert.ok(tagCols.has("frecencyScore"), "tags should have frecencyScore");
      assert.ok(tagCols.has("createdAt"), "tags should have createdAt");
      // Verify tags.id is now TEXT (was INTEGER AUTOINCREMENT)
      const tagIdCol = conn.all("PRAGMA table_info(tags)").find(c => c.name === "id");
      assert.ok(tagIdCol, "tags should have id column");
      assert.strictEqual(tagIdCol.type, "TEXT", "tags.id should be TEXT after rebuild");

      const itCols = new Set(conn.all("PRAGMA table_info(item_tags)").map(c => c.name));
      assert.ok(itCols.has("itemId"), "item_tags should have itemId");
      assert.ok(itCols.has("tagId"), "item_tags should have tagId");
      // Verify item_tags.tagId is now TEXT (was INTEGER)
      const itTagIdCol = conn.all("PRAGMA table_info(item_tags)").find(c => c.name === "tagId");
      assert.ok(itTagIdCol, "item_tags should have tagId column");
      assert.strictEqual(itTagIdCol.type, "TEXT", "item_tags.tagId should be TEXT after rebuild");

      // Verify data survived the rebuild
      const items = freshDb.getItems("rebuild-user");
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].content, "https://example.com");

      const tags = freshDb.getTagsByFrecency("rebuild-user");
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, "test");
      assert.strictEqual(tags[0].frequency, 3, "tag frequency should be preserved");

      // Verify new items can be saved
      const newId = freshDb.saveUrl("rebuild-user", "https://new.com", ["newtag"]);
      assert.ok(newId);
      assert.strictEqual(freshDb.getItems("rebuild-user").length, 2);

      freshDb.closeAllConnections();
    });

    it("should drop a stale 4-type CHECK so entity/series/feed can be stored", () => {
      // The prod-bucket state that 500'd: items already camelCase (no column
      // renames pending), but the type column still carries the OLD 4-value CHECK.
      // Only the dedicated stale-CHECK detection (not the rename path) rebuilds it.
      const { DatabaseSync } = require("node:sqlite");
      const ecDir = path.join(TEST_DATA_DIR, "entity-check-user", "profiles", "default");
      fs.mkdirSync(ecDir, { recursive: true });
      const ecDb = new DatabaseSync(path.join(ecDir, "datastore.sqlite"));
      ecDb.exec("PRAGMA journal_mode = WAL");
      ecDb.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('url', 'text', 'tagset', 'image')),
          content TEXT,
          metadata TEXT,
          syncId TEXT DEFAULT '',
          syncedAt INTEGER DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          deletedAt INTEGER DEFAULT 0,
          createdByDevice TEXT DEFAULT ''
        );
      `);
      // A pre-existing url must survive the rebuild.
      ecDb.prepare(
        "INSERT INTO items (id, type, content, createdAt, updatedAt) VALUES ('ec-1','url','https://keep.example.com',1,1)"
      ).run();
      ecDb.close();

      delete require.cache[require.resolve("./db")];
      const freshDb = require("./db");
      // getConnection -> initializeSchema must detect the stale CHECK and rebuild.
      freshDb.getConnection("entity-check-user");

      // The CHECK is gone: previously-rejected derived types now insert.
      const entId = freshDb.saveItem("entity-check-user", "entity", null, [], { entityType: "person", name: "Ada" });
      assert.ok(entId, "entity should save after the stale CHECK is dropped");
      const feedId = freshDb.saveItem("entity-check-user", "feed", "https://example.com/feed.xml", []);
      assert.ok(feedId, "feed should save too");

      // Pre-existing data survived the rebuild.
      const items = freshDb.getItems("entity-check-user");
      const urls = items.filter((i) => i.type === "url");
      assert.strictEqual(urls.length, 1, "the pre-existing url survived");
      assert.strictEqual(urls[0].content, "https://keep.example.com");
      assert.ok(items.some((i) => i.type === "entity"), "entity is stored");

      freshDb.closeAllConnections();
    });
  });

  describe("Missing Columns Safety Net", () => {
    it("should add missing columns when tags table has incomplete schema", () => {
      // Simulate a legacy DB where tags table was created without some columns
      // (e.g., an older version of the code that didn't have frecencyScore or lastUsed)
      const { DatabaseSync } = require("node:sqlite");
      const mcDir = path.join(TEST_DATA_DIR, "missing-cols-user", "profiles", "default");
      fs.mkdirSync(mcDir, { recursive: true });
      const mcDb = new DatabaseSync(path.join(mcDir, "datastore.sqlite"));
      mcDb.exec("PRAGMA journal_mode = WAL");

      // Minimal tags table — missing lastUsed, frecencyScore, createdAt, updatedAt
      mcDb.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT,
          metadata TEXT,
          syncId TEXT DEFAULT '',
          syncSource TEXT DEFAULT '',
          syncedAt INTEGER DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          deletedAt INTEGER DEFAULT 0
        );
        CREATE TABLE tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          frequency INTEGER DEFAULT 1
        );
        CREATE TABLE item_tags (
          itemId TEXT NOT NULL,
          tagId TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          PRIMARY KEY (itemId, tagId)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);

      // Insert test data with minimal columns
      mcDb.prepare("INSERT INTO tags (id, name, frequency) VALUES ('t1', 'testtag', 3)").run();
      mcDb.close();

      // Open via db module — should add missing columns without crashing
      delete require.cache[require.resolve("./db")];
      const freshDb = require("./db");
      const conn = freshDb.getConnection("missing-cols-user");

      // Verify all required columns exist
      const tagCols = new Set(conn.all("PRAGMA table_info(tags)").map(c => c.name));
      assert.ok(tagCols.has("lastUsed"), "tags should have lastUsed after safety net");
      assert.ok(tagCols.has("frecencyScore"), "tags should have frecencyScore after safety net");
      assert.ok(tagCols.has("createdAt"), "tags should have createdAt after safety net");
      assert.ok(tagCols.has("updatedAt"), "tags should have updatedAt after safety net");

      // Verify existing data survived
      const tags = freshDb.getTagsByFrecency("missing-cols-user");
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, "testtag");
      assert.strictEqual(tags[0].frequency, 3);

      // Verify new operations work
      freshDb.saveUrl("missing-cols-user", "https://example.com", ["newtag"]);
      const items = freshDb.getItems("missing-cols-user");
      assert.strictEqual(items.length, 1);

      freshDb.closeAllConnections();
    });
  });

  describe("TEXT Timestamp Migration", () => {
    it("should convert ISO string and stringified number timestamps to integers", () => {
      const { DatabaseSync } = require("node:sqlite");
      const tsDir = path.join(TEST_DATA_DIR, "ts-user", "profiles", "default");
      fs.mkdirSync(tsDir, { recursive: true });
      const tsDb = new DatabaseSync(path.join(tsDir, "datastore.sqlite"));
      tsDb.exec("PRAGMA journal_mode = WAL");

      // Create schema with TEXT affinity columns (simulates production)
      tsDb.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT,
          metadata TEXT,
          syncId TEXT DEFAULT '',
          syncSource TEXT DEFAULT '',
          syncedAt TEXT DEFAULT '0',
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          deletedAt TEXT DEFAULT '0'
        );
        CREATE TABLE tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          frequency INTEGER DEFAULT 1,
          lastUsed TEXT NOT NULL,
          frecencyScore REAL DEFAULT 0.0,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE item_tags (
          itemId TEXT NOT NULL,
          tagId TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          PRIMARY KEY (itemId, tagId)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);

      // Insert items with TEXT timestamps (ISO strings and stringified numbers)
      tsDb.prepare(`
        INSERT INTO items (id, type, content, syncId, syncSource, syncedAt, createdAt, updatedAt, deletedAt)
        VALUES ('iso-1', 'text', 'hello', '', '', '0', '2026-01-27T21:12:47.876Z', '2026-01-27T21:12:47.876Z', '0')
      `).run();
      tsDb.prepare(`
        INSERT INTO items (id, type, content, syncId, syncSource, syncedAt, createdAt, updatedAt, deletedAt)
        VALUES ('num-1', 'url', 'https://example.com', '', '', '0', '1769559596558.0', '1769559596558.0', '1769509253170')
      `).run();
      tsDb.prepare(`
        INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
        VALUES ('tag-1', 'test', 1, '2026-01-27T12:00:00.000Z', 10.0, '2026-01-27T12:00:00.000Z', '2026-01-27T12:00:00.000Z')
      `).run();
      tsDb.prepare(`
        INSERT INTO item_tags (itemId, tagId, createdAt) VALUES ('iso-1', 'tag-1', '2026-01-27T12:00:00.000Z')
      `).run();
      tsDb.close();

      // Open via db module — initializeSchema should migrate timestamps
      delete require.cache[require.resolve("./db")];
      const freshDb = require("./db");
      const conn = freshDb.getConnection("ts-user");

      // DB values are numeric (ISO converted to Unix ms, float strings to integers)
      // but may remain TEXT type due to column TEXT affinity from legacy schema.
      // The toTimestamp() safety net in response code ensures API returns integers.
      const row1 = conn.get("SELECT CAST(createdAt AS INTEGER) as v FROM items WHERE id = 'iso-1'");
      assert.ok(row1.v > 1700000000000, `ISO timestamp should be Unix ms, got ${row1.v}`);

      const row2 = conn.get("SELECT CAST(createdAt AS INTEGER) as v, CAST(deletedAt AS INTEGER) as dv FROM items WHERE id = 'num-1'");
      assert.strictEqual(row2.v, 1769559596558, `Should preserve value: ${row2.v}`);
      assert.strictEqual(row2.dv, 1769509253170);

      // Verify API response returns JavaScript numbers (the critical fix for clients)
      const items = freshDb.getItems("ts-user", null, "default", true);
      assert.strictEqual(items.length, 2);
      for (const item of items) {
        assert.strictEqual(typeof item.createdAt, "number", `createdAt should be number, got ${typeof item.createdAt}: ${item.createdAt}`);
        assert.strictEqual(typeof item.updatedAt, "number", `updatedAt should be number, got ${typeof item.updatedAt}: ${item.updatedAt}`);
        assert.strictEqual(typeof item.deletedAt, "number", `deletedAt should be number, got ${typeof item.deletedAt}: ${item.deletedAt}`);
      }

      // Verify getItemsSince works correctly with TEXT-affinity timestamps
      const sinceItems = freshDb.getItemsSince("ts-user", 0, null, "default");
      assert.strictEqual(sinceItems.length, 2, `getItemsSince(0) should return all items`);
      for (const item of sinceItems) {
        assert.strictEqual(typeof item.createdAt, "number");
        assert.strictEqual(typeof item.updatedAt, "number");
      }

      freshDb.closeAllConnections();
    });
  });

  describe("Production State: snake_case + TEXT timestamps", () => {
    it("should handle legacy DB with snake_case columns AND TEXT timestamps end-to-end", () => {
      // This is the actual production state that caused the crash:
      // snake_case columns with TEXT-affinity timestamps
      const { DatabaseSync } = require("node:sqlite");
      const prodDir = path.join(TEST_DATA_DIR, "prod-user", "profiles", "default");
      fs.mkdirSync(prodDir, { recursive: true });
      const prodDb = new DatabaseSync(path.join(prodDir, "datastore.sqlite"));
      prodDb.exec("PRAGMA journal_mode = WAL");

      // Create legacy schema: snake_case columns with TEXT affinity
      prodDb.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT,
          metadata TEXT,
          sync_id TEXT DEFAULT '',
          sync_source TEXT DEFAULT '',
          synced_at TEXT DEFAULT '0',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT DEFAULT '0'
        );
        CREATE TABLE tags (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          frequency INTEGER DEFAULT 1,
          last_used_at TEXT NOT NULL,
          frecency_score REAL DEFAULT 0.0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE item_tags (
          item_id TEXT NOT NULL,
          tag_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (item_id, tag_id)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      `);

      // Insert production-like data with TEXT timestamps
      prodDb.prepare(`
        INSERT INTO items (id, type, content, sync_id, sync_source, synced_at, created_at, updated_at, deleted_at)
        VALUES ('prod-1', 'url', 'https://example.com', '', '', '0', '2026-01-27T21:12:47.876Z', '2026-01-27T21:12:47.876Z', '0')
      `).run();
      prodDb.prepare(`
        INSERT INTO items (id, type, content, sync_id, sync_source, synced_at, created_at, updated_at, deleted_at)
        VALUES ('prod-2', 'text', 'A note', '', '', '0', '1769559596558.0', '1769559596558.0', '0')
      `).run();
      prodDb.prepare(`
        INSERT INTO tags (id, name, frequency, last_used_at, frecency_score, created_at, updated_at)
        VALUES ('tag-1', 'test', 1, '2026-01-27T12:00:00.000Z', 10.0, '2026-01-27T12:00:00.000Z', '2026-01-27T12:00:00.000Z')
      `).run();
      prodDb.prepare(`
        INSERT INTO item_tags (item_id, tag_id, created_at) VALUES ('prod-1', 'tag-1', '2026-01-27T12:00:00.000Z')
      `).run();
      prodDb.close();

      // Open via db module — must not crash
      delete require.cache[require.resolve("./db")];
      const freshDb = require("./db");
      const conn = freshDb.getConnection("prod-user");

      // Verify columns were renamed to camelCase
      const itemCols = new Set(conn.all("PRAGMA table_info(items)").map(c => c.name));
      assert.ok(itemCols.has("syncId"), "sync_id should be renamed to syncId");
      assert.ok(itemCols.has("createdAt"), "created_at should be renamed to createdAt");
      assert.ok(itemCols.has("deletedAt"), "deleted_at should be renamed to deletedAt");

      const tagCols = new Set(conn.all("PRAGMA table_info(tags)").map(c => c.name));
      assert.ok(tagCols.has("lastUsed"), "last_used_at should be renamed to lastUsed");
      assert.ok(tagCols.has("frecencyScore"), "frecency_score should be renamed to frecencyScore");

      const itCols = new Set(conn.all("PRAGMA table_info(item_tags)").map(c => c.name));
      assert.ok(itCols.has("itemId"), "item_id should be renamed to itemId");
      assert.ok(itCols.has("tagId"), "tag_id should be renamed to tagId");

      // Verify getItems works (exercises runtime queries)
      const items = freshDb.getItems("prod-user");
      assert.strictEqual(items.length, 2);
      for (const item of items) {
        assert.strictEqual(typeof item.createdAt, "number", `createdAt should be number`);
        assert.strictEqual(typeof item.updatedAt, "number", `updatedAt should be number`);
        assert.strictEqual(typeof item.deletedAt, "number", `deletedAt should be number`);
        assert.ok(item.createdAt > 0, `createdAt should be positive`);
      }

      // Verify getItemsSince works (exercises CAST query)
      const sinceItems = freshDb.getItemsSince("prod-user", 0);
      assert.strictEqual(sinceItems.length, 2);

      // Verify getTagsByFrecency works
      const tags = freshDb.getTagsByFrecency("prod-user");
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, "test");

      // Verify saving new items works on the migrated DB
      const newId = freshDb.saveUrl("prod-user", "https://new.com", ["newtag"]);
      assert.ok(newId);
      const allItems = freshDb.getItems("prod-user");
      assert.strictEqual(allItems.length, 3);

      // Verify deleteItem works
      freshDb.deleteItem("prod-user", "prod-1");
      assert.strictEqual(freshDb.getItems("prod-user").length, 2);

      freshDb.closeAllConnections();
    });
  });

  describe("sync_id Deduplication", () => {
    it("should deduplicate by sync_id and return same server id", () => {
      // Simulate same item pushed twice with same sync_id
      const clientSyncId = "client-item-abc123";
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://example.com", ["tag1"], null, clientSyncId);
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://example.com", ["tag2"], null, clientSyncId);

      // Should return same server ID
      assert.strictEqual(id1, id2, "should return same id for same sync_id");

      // Should only have one item
      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 1);
      // Tags should be replaced
      assert.deepStrictEqual(items[0].tags, ["tag2"]);
    });

    it("should deduplicate by sync_id even with different content", () => {
      // Client updates content before syncing again
      const clientSyncId = "client-item-xyz789";
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://old-url.com", [], null, clientSyncId);
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://new-url.com", [], null, clientSyncId);

      // Should return same server ID (sync_id match takes priority)
      assert.strictEqual(id1, id2, "should return same id for same sync_id even with different content");

      // Should only have one item
      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 1);
    });

    it("should still use content-based dedup when no sync_id provided", () => {
      // Backwards compatibility: no sync_id uses content-based dedup
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://example.com", ["tag1"]);
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://example.com", ["tag2"]);

      // Should return same server ID (content match)
      assert.strictEqual(id1, id2);

      // Should only have one item
      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 1);
    });

    it("should create new item when sync_id and content are both new", () => {
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://first.com", [], null, "sync-1");
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://second.com", [], null, "sync-2");

      // Should create different items
      assert.notStrictEqual(id1, id2);

      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 2);
    });

    it("should not use content dedup when sync_id is provided", () => {
      // Sync path: two different sync_ids with same content are separate items
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://example.com", [], null, "device-a-id");
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://example.com", [], null, "device-b-id");

      // Different sync_ids → different server items (no content-based fallback in sync path)
      assert.notStrictEqual(id1, id2);

      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 2);
    });

    it("should match deleted items by sync_id and undelete them", () => {
      // Create and delete an item
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://example.com", [], null, "deleted-sync-id");
      db.deleteItem(TEST_USER_ID, id1);

      // Push new content with same sync_id — should match and undelete
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://example.com", [], null, "deleted-sync-id");

      // Should match the existing (deleted) item and undelete it
      assert.strictEqual(id1, id2, "should match deleted item by sync_id");

      // Item should be undeleted
      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].id, id1);
    });

    it("should accept tombstone push via sync_id with deleted_at", () => {
      // Create an item
      const id = db.saveItem(TEST_USER_ID, "url", "https://example.com", [], null, "tomb-sync-id");
      assert.strictEqual(db.getItems(TEST_USER_ID).length, 1);

      // Push tombstone with deleted_at
      const deletedAt = Date.now();
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://example.com", [], null, "tomb-sync-id", "default", deletedAt);
      assert.strictEqual(id, id2, "should match by sync_id");

      // Item should be soft-deleted
      assert.strictEqual(db.getItems(TEST_USER_ID).length, 0);
      const allItems = db.getItems(TEST_USER_ID, null, "default", true);
      assert.strictEqual(allItems.length, 1);
      assert.ok(allItems[0].deletedAt > 0);
    });

    it("should match when device re-pushes with server ID as sync_id", () => {
      // Device pushes first time with local ID
      const id1 = db.saveItem(TEST_USER_ID, "url", "https://shared.com", ["v1"], null, "device-local-id");

      // Device stores server id (id1) as sync_id, re-pushes with it after local edit
      const id2 = db.saveItem(TEST_USER_ID, "url", "https://shared.com/updated", ["v2"], null, id1);

      // Should match by server ID and return same item
      assert.strictEqual(id1, id2);

      const items = db.getItems(TEST_USER_ID);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].content, "https://shared.com/updated");
    });
  });
});

describe("Users Module Tests", () => {
  let users;

  beforeEach(() => {
    delete require.cache[require.resolve("./users")];
    cleanTestDir();
    users = require("./users");
  });

  after(() => {
    if (users && users.closeSystemDb) {
      users.closeSystemDb();
    }
  });

  describe("createUser", () => {
    it("should create a user and return API key", () => {
      const result = users.createUser("alice");

      assert.strictEqual(result.userId, "alice");
      assert.ok(result.apiKey, "should return an API key");
      assert.strictEqual(result.apiKey.length, 64, "API key should be 64 hex chars");
    });

    it("should reject duplicate user IDs", () => {
      users.createUser("bob");

      assert.throws(
        () => users.createUser("bob"),
        /already exists/
      );
    });
  });

  describe("createUserWithKey", () => {
    it("should create user with existing key", () => {
      const existingKey = "my-existing-api-key-from-env";
      const result = users.createUserWithKey("migrated", existingKey);

      assert.strictEqual(result.userId, "migrated");
      assert.ok(!result.apiKey, "should not return key");

      // Key should work for auth
      const foundUserId = users.getUserIdFromApiKey(existingKey);
      assert.strictEqual(foundUserId, "migrated");
    });

    it("should reject duplicate user IDs", () => {
      users.createUserWithKey("existing", "key1");

      assert.throws(
        () => users.createUserWithKey("existing", "key2"),
        /already exists/
      );
    });
  });

  describe("getUserIdFromApiKey", () => {
    it("should return userId for valid API key", () => {
      const { userId, apiKey } = users.createUser("charlie");
      const foundUserId = users.getUserIdFromApiKey(apiKey);

      assert.strictEqual(foundUserId, userId);
    });

    it("should return null for invalid API key", () => {
      const result = users.getUserIdFromApiKey("invalid-key");
      assert.strictEqual(result, null);
    });

    it("should return null for empty API key", () => {
      assert.strictEqual(users.getUserIdFromApiKey(""), null);
      assert.strictEqual(users.getUserIdFromApiKey(null), null);
      assert.strictEqual(users.getUserIdFromApiKey(undefined), null);
    });
  });

  describe("listUsers", () => {
    it("should list all users", () => {
      users.createUser("user1");
      users.createUser("user2");

      const list = users.listUsers();
      assert.strictEqual(list.length, 2);
      assert.ok(list.find((u) => u.id === "user1"));
      assert.ok(list.find((u) => u.id === "user2"));
    });

    it("should not expose API keys", () => {
      users.createUser("secure");
      const list = users.listUsers();

      assert.ok(!list[0].apiKey);
      assert.ok(!list[0].api_key);
      assert.ok(!list[0].api_key_hash);
    });
  });

  describe("deleteUser", () => {
    it("should delete a user", () => {
      const { apiKey } = users.createUser("toDelete");
      assert.ok(users.getUserIdFromApiKey(apiKey));

      users.deleteUser("toDelete");
      assert.strictEqual(users.getUserIdFromApiKey(apiKey), null);
    });
  });

  describe("regenerateApiKey", () => {
    it("should generate new API key for existing user", () => {
      const { apiKey: oldKey } = users.createUser("regen");
      const { apiKey: newKey } = users.regenerateApiKey("regen");

      assert.notStrictEqual(oldKey, newKey);
      assert.strictEqual(users.getUserIdFromApiKey(oldKey), null);
      assert.strictEqual(users.getUserIdFromApiKey(newKey), "regen");
    });

    it("should reject non-existent user", () => {
      assert.throws(
        () => users.regenerateApiKey("nonexistent"),
        /does not exist/
      );
    });
  });

  describe("hashApiKey", () => {
    it("should produce consistent hashes", () => {
      const hash1 = users.hashApiKey("test-key");
      const hash2 = users.hashApiKey("test-key");

      assert.strictEqual(hash1, hash2);
    });

    it("should produce different hashes for different keys", () => {
      const hash1 = users.hashApiKey("key1");
      const hash2 = users.hashApiKey("key2");

      assert.notStrictEqual(hash1, hash2);
    });
  });
});

describe("Devices Module Tests", () => {
  let users;

  beforeEach(() => {
    delete require.cache[require.resolve("./users")];
    cleanTestDir();
    users = require("./users");
    users.createUser("owner");
  });

  after(() => {
    if (users && users.closeSystemDb) {
      users.closeSystemDb();
    }
  });

  describe("createDevice", () => {
    it("should mint a device key bound to the user", () => {
      const d = users.createDevice("owner", "iPhone");
      assert.ok(d.deviceId, "should return a deviceId");
      assert.strictEqual(d.userId, "owner");
      assert.strictEqual(d.label, "iPhone");
      assert.strictEqual(d.apiKey.length, 64, "key should be 64 hex chars");

      const cred = users.resolveDevice(d.apiKey);
      assert.strictEqual(cred.userId, "owner");
      assert.strictEqual(cred.deviceId, d.deviceId);
      assert.strictEqual(cred.label, "iPhone");
    });

    it("should give each device a distinct key", () => {
      const a = users.createDevice("owner", "phone");
      const b = users.createDevice("owner", "laptop");
      assert.notStrictEqual(a.apiKey, b.apiKey);
      assert.notStrictEqual(a.deviceId, b.deviceId);
    });

    it("should reject an unknown user", () => {
      assert.throws(() => users.createDevice("nobody", "x"), /does not exist/);
    });

    it("should reject an empty label", () => {
      assert.throws(() => users.createDevice("owner", ""), /label is required/);
      assert.throws(() => users.createDevice("owner", "   "), /label is required/);
    });
  });

  describe("resolveDevice", () => {
    it("should return null for an unknown key", () => {
      assert.strictEqual(users.resolveDevice("nope"), null);
      assert.strictEqual(users.resolveDevice(""), null);
      assert.strictEqual(users.resolveDevice(null), null);
    });

    it("should fall back to a legacy users-table key (pre-migration)", () => {
      // A key that only lives in the users table (no device row) still
      // authenticates, but without a device identity.
      const { apiKey } = users.createUser("legacyuser");
      const cred = users.resolveDevice(apiKey);
      assert.strictEqual(cred.userId, "legacyuser");
      assert.strictEqual(cred.deviceId, null);
      assert.strictEqual(cred.legacy, true);
    });

    it("should bump last_seen_at on a successful resolve", () => {
      const d = users.createDevice("owner", "watch");
      users.resolveDevice(d.apiKey);
      const [dev] = users.listDevices("owner").filter((x) => x.id === d.deviceId);
      assert.ok(dev.last_seen_at, "last_seen_at should be set after a resolve");
    });
  });

  describe("revokeDevice", () => {
    it("should reject a revoked device key without affecting others", () => {
      const a = users.createDevice("owner", "rogue");
      const b = users.createDevice("owner", "keeper");

      const revoked = users.revokeDevice("owner", a.deviceId);
      assert.strictEqual(revoked, true);

      // Revoked key is rejected (well-formed but no longer valid).
      assert.deepStrictEqual(users.resolveDevice(a.apiKey), { revoked: true });
      // Other device is unaffected — the whole point of per-device creds.
      assert.strictEqual(users.resolveDevice(b.apiKey).deviceId, b.deviceId);
    });

    it("should be idempotent", () => {
      const d = users.createDevice("owner", "x");
      assert.strictEqual(users.revokeDevice("owner", d.deviceId), true);
      assert.strictEqual(users.revokeDevice("owner", d.deviceId), false);
    });

    it("should reject revoking another user's / unknown device", () => {
      assert.throws(() => users.revokeDevice("owner", "no-such-device"), /not found/);
    });
  });

  describe("listDevices", () => {
    it("should list devices without key material, including revoked", () => {
      const a = users.createDevice("owner", "one");
      users.createDevice("owner", "two");
      users.revokeDevice("owner", a.deviceId);

      const list = users.listDevices("owner");
      assert.strictEqual(list.length, 2);
      for (const dev of list) {
        assert.ok(!dev.key_hash, "must not expose key_hash");
        assert.ok(!dev.apiKey, "must not expose apiKey");
      }
      const revoked = list.find((d) => d.id === a.deviceId);
      assert.ok(revoked.revoked_at, "revoked device should show revoked_at");
    });
  });

  describe("migrateLegacyKeysToDevices", () => {
    it("should migrate a user's legacy key into a device and keep it working", () => {
      users.createUserWithKey("legacyowner", "shared-legacy-key");

      users.migrateLegacyKeysToDevices();

      const devices = users.listDevices("legacyowner");
      assert.strictEqual(devices.length, 1);
      assert.strictEqual(devices[0].label, "legacy-shared");

      const cred = users.resolveDevice("shared-legacy-key");
      assert.strictEqual(cred.userId, "legacyowner");
      assert.ok(cred.deviceId, "legacy key should now resolve to a device id");
      assert.ok(!cred.legacy, "should no longer be a legacy fallback after migration");

      // The migrated device is individually revocable.
      assert.strictEqual(users.revokeDevice("legacyowner", cred.deviceId), true);
      assert.deepStrictEqual(users.resolveDevice("shared-legacy-key"), { revoked: true });
    });

    it("should be idempotent", () => {
      users.createUserWithKey("idem", "k");
      users.migrateLegacyKeysToDevices();
      users.migrateLegacyKeysToDevices();
      assert.strictEqual(users.listDevices("idem").length, 1);
    });
  });
});

describe("MCP Grants Module Tests", () => {
  let users;
  let grants;

  beforeEach(() => {
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./grants")];
    cleanTestDir();
    users = require("./users");
    grants = require("./grants");
    users.createUser("owner");
  });

  after(() => {
    if (users && users.closeSystemDb) {
      users.closeSystemDb();
    }
  });

  describe("createGrant", () => {
    it("should mint a grant key bound to the user, scope, and profile", () => {
      const g = grants.createGrant("owner", "nightly agent", "work", false, "profile-a");
      assert.ok(g.grantId, "should return a grantId");
      assert.strictEqual(g.userId, "owner");
      assert.strictEqual(g.label, "nightly agent");
      assert.strictEqual(g.scopeTag, "work");
      assert.strictEqual(g.readonly, false);
      assert.strictEqual(g.profileId, "profile-a");
      assert.strictEqual(g.apiKey.length, 64, "key should be 64 hex chars");

      const cred = grants.resolveMcpGrant(g.apiKey);
      assert.strictEqual(cred.userId, "owner");
      assert.strictEqual(cred.grantId, g.grantId);
      assert.strictEqual(cred.scopeTag, "work");
      assert.strictEqual(cred.readonly, false);
      assert.strictEqual(cred.profileId, "profile-a");
    });

    it("should permit an unscoped grant (scopeTag '')", () => {
      const g = grants.createGrant("owner", "whole-store agent", "", true, "profile-a");
      assert.strictEqual(g.scopeTag, "");
      const cred = grants.resolveMcpGrant(g.apiKey);
      assert.strictEqual(cred.scopeTag, "");
      assert.strictEqual(cred.readonly, true);
    });

    it("should give each grant a distinct key", () => {
      const a = grants.createGrant("owner", "one", "x", false, "p");
      const b = grants.createGrant("owner", "two", "y", false, "p");
      assert.notStrictEqual(a.apiKey, b.apiKey);
      assert.notStrictEqual(a.grantId, b.grantId);
    });

    it("should reject an unknown user", () => {
      assert.throws(() => grants.createGrant("nobody", "x", "tag", false, "p"), /does not exist/);
    });

    it("should reject an empty label", () => {
      assert.throws(() => grants.createGrant("owner", "", "tag", false, "p"), /label is required/);
    });

    it("should reject a missing profileId", () => {
      assert.throws(() => grants.createGrant("owner", "x", "tag", false, ""), /profileId is required/);
    });
  });

  describe("resolveMcpGrant", () => {
    it("should return null for an unknown key", () => {
      assert.strictEqual(grants.resolveMcpGrant("nope"), null);
      assert.strictEqual(grants.resolveMcpGrant(""), null);
      assert.strictEqual(grants.resolveMcpGrant(null), null);
    });

    it("should bump last_seen_at on a successful resolve", () => {
      const g = grants.createGrant("owner", "watch", "tag", false, "p");
      grants.resolveMcpGrant(g.apiKey);
      const [row] = grants.listGrants("owner").filter((x) => x.id === g.grantId);
      assert.ok(row.last_seen_at, "last_seen_at should be set after a resolve");
    });

    it("must never resolve a device key (separation from the sync credential namespace)", () => {
      const device = users.createDevice("owner", "phone");
      assert.strictEqual(grants.resolveMcpGrant(device.apiKey), null);
    });
  });

  describe("revokeGrant", () => {
    it("should reject a revoked grant key without affecting others", () => {
      const a = grants.createGrant("owner", "rogue", "tag", false, "p");
      const b = grants.createGrant("owner", "keeper", "tag", false, "p");

      const revoked = grants.revokeGrant("owner", a.grantId);
      assert.strictEqual(revoked, true);

      assert.deepStrictEqual(grants.resolveMcpGrant(a.apiKey), { revoked: true });
      assert.strictEqual(grants.resolveMcpGrant(b.apiKey).grantId, b.grantId);
    });

    it("should be idempotent", () => {
      const g = grants.createGrant("owner", "x", "tag", false, "p");
      assert.strictEqual(grants.revokeGrant("owner", g.grantId), true);
      assert.strictEqual(grants.revokeGrant("owner", g.grantId), false);
    });

    it("should reject revoking another user's / unknown grant", () => {
      assert.throws(() => grants.revokeGrant("owner", "no-such-grant"), /not found/);
    });
  });

  describe("listGrants", () => {
    it("should list grants without key material, including revoked", () => {
      const a = grants.createGrant("owner", "one", "tag", false, "p");
      grants.revokeGrant("owner", a.grantId);
      const b = grants.createGrant("owner", "two", "tag2", true, "p2");

      const list = grants.listGrants("owner");
      assert.strictEqual(list.length, 2);
      for (const row of list) {
        assert.strictEqual(row.apiKey, undefined);
        assert.strictEqual(row.key_hash, undefined);
      }
      const revokedRow = list.find((r) => r.id === a.grantId);
      assert.ok(revokedRow.revoked_at, "revoked grant should still be listed");
      const readonlyRow = list.find((r) => r.id === b.grantId);
      assert.strictEqual(readonlyRow.readonly, true);
      assert.strictEqual(readonlyRow.scopeTag, "tag2");
      assert.strictEqual(readonlyRow.profileId, "p2");
    });
  });
});

describe("Write Attribution Tests", () => {
  let db;
  let users;

  beforeEach(() => {
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    cleanTestDir();
    db = require("./db");
    users = require("./users");
    users.createUser("attr");
  });

  after(() => {
    if (db && db.closeAllConnections) db.closeAllConnections();
    if (users && users.closeSystemDb) users.closeSystemDb();
  });

  it("should stamp createdByDevice on a new item and expose it on read", () => {
    const dev = users.createDevice("attr", "phone");
    const id = db.saveItem("attr", "text", "hello", [], null, null, "default", null, dev.deviceId);

    const item = db.getItemById("attr", id);
    assert.strictEqual(item.createdByDevice, dev.deviceId);

    const all = db.getItems("attr");
    assert.strictEqual(all.find((i) => i.id === id).createdByDevice, dev.deviceId);
  });

  it("should default createdByDevice to empty string when no device given", () => {
    const id = db.saveItem("attr", "text", "anon", [], null, null, "default");
    assert.strictEqual(db.getItemById("attr", id).createdByDevice, "");
  });

  it("should not overwrite createdByDevice on a sync update from another device", () => {
    // Creation stamps device A; a later sync push (matched by syncId) is an
    // UPDATE and must NOT change the original creator attribution.
    const a = users.createDevice("attr", "deviceA");
    const id = db.saveItem("attr", "text", "v1", [], null, "sync-1", "default", null, a.deviceId);
    db.saveItem("attr", "text", "v2", [], null, "sync-1", "default", null, "deviceB");

    const item = db.getItemById("attr", id);
    assert.strictEqual(item.content, "v2", "content should update");
    assert.strictEqual(item.createdByDevice, a.deviceId, "creator attribution should be preserved");
  });
});

describe("API Tests", () => {
  let app;
  let db;
  let users;
  let TEST_API_KEY;
  const TEST_USER = "apitest";

  beforeEach(() => {
    // Clean up
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    cleanTestDir();

    db = require("./db");
    users = require("./users");

    // Create test user
    const result = users.createUser(TEST_USER);
    TEST_API_KEY = result.apiKey;

    // Create fresh Hono app with auth
    const { Hono } = require("hono");
    app = new Hono();

    // Auth middleware
    app.use("*", async (c, next) => {
      if (c.req.path === "/") return next();
      const auth = c.req.header("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const apiKey = auth.slice(7);
      const userId = users.getUserIdFromApiKey(apiKey);
      if (!userId) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.set("userId", userId);
      return next();
    });

    // Routes
    app.get("/", (c) => c.json({ status: "ok" }));

    app.post("/webhook", async (c) => {
      const userId = c.get("userId");
      const body = await c.req.json();
      const saved = [];
      if (body.urls && Array.isArray(body.urls)) {
        for (const item of body.urls) {
          if (item.url) {
            const id = db.saveUrl(userId, item.url, item.tags || []);
            saved.push({ id, url: item.url });
          }
        }
      }
      return c.json({ received: true, saved_count: saved.length });
    });

    app.get("/urls", (c) => c.json({ urls: db.getSavedUrls(c.get("userId")) }));
    app.get("/tags", (c) => c.json({ tags: db.getTagsByFrecency(c.get("userId")) }));
    app.delete("/urls/:id", (c) => {
      db.deleteUrl(c.get("userId"), c.req.param("id"));
      return c.json({ deleted: true });
    });
    app.patch("/urls/:id/tags", async (c) => {
      const body = await c.req.json();
      db.updateUrlTags(c.get("userId"), c.req.param("id"), body.tags || []);
      return c.json({ updated: true });
    });

    // Texts endpoints
    app.post("/texts", async (c) => {
      const userId = c.get("userId");
      const body = await c.req.json();
      if (!body.content) {
        return c.json({ error: "content is required" }, 400);
      }
      const id = db.saveText(userId, body.content, body.tags || []);
      return c.json({ id, created: true });
    });
    app.get("/texts", (c) => c.json({ texts: db.getTexts(c.get("userId")) }));
    app.delete("/texts/:id", (c) => {
      db.deleteItem(c.get("userId"), c.req.param("id"));
      return c.json({ deleted: true });
    });

    // Tagsets endpoints
    app.post("/tagsets", async (c) => {
      const userId = c.get("userId");
      const body = await c.req.json();
      if (!body.tags || !Array.isArray(body.tags) || body.tags.length === 0) {
        return c.json({ error: "tags array is required" }, 400);
      }
      const id = db.saveTagset(userId, body.tags);
      return c.json({ id, created: true });
    });
    app.get("/tagsets", (c) => c.json({ tagsets: db.getTagsets(c.get("userId")) }));
    app.delete("/tagsets/:id", (c) => {
      db.deleteItem(c.get("userId"), c.req.param("id"));
      return c.json({ deleted: true });
    });

    // Unified items endpoints
    app.post("/items", async (c) => {
      const userId = c.get("userId");
      const body = await c.req.json();
      const { type, content, tags = [] } = body;
      if (!type || !["url", "text", "tagset"].includes(type)) {
        return c.json({ error: "invalid type" }, 400);
      }
      const id = db.saveItem(userId, type, content || null, tags);
      return c.json({ id, type, created: true });
    });
    app.get("/items", (c) => {
      const type = c.req.query("type");
      const items = db.getItems(c.get("userId"), type || null);
      return c.json({ items });
    });
    app.delete("/items/:id", (c) => {
      db.deleteItem(c.get("userId"), c.req.param("id"));
      return c.json({ deleted: true });
    });
  });

  function authHeaders() {
    return { Authorization: `Bearer ${TEST_API_KEY}` };
  }

  describe("Auth", () => {
    it("should allow health check without auth", async () => {
      const res = await app.request("/");
      assert.strictEqual(res.status, 200);
    });

    it("should reject requests without auth", async () => {
      const res = await app.request("/urls");
      assert.strictEqual(res.status, 401);
    });

    it("should reject requests with wrong key", async () => {
      const res = await app.request("/urls", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      assert.strictEqual(res.status, 401);
    });

    it("should accept requests with valid auth", async () => {
      const res = await app.request("/urls", { headers: authHeaders() });
      assert.strictEqual(res.status, 200);
    });
  });

  describe("GET /", () => {
    it("should return ok status", async () => {
      const res = await app.request("/");
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.status, "ok");
    });
  });

  describe("POST /webhook", () => {
    it("should save URLs from webhook payload", async () => {
      const res = await app.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          urls: [
            { url: "https://example1.com", tags: ["tag1"] },
            { url: "https://example2.com", tags: ["tag2"] },
          ],
        }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.received, true);
      assert.strictEqual(json.saved_count, 2);

      // Verify saved
      const urls = db.getSavedUrls(TEST_USER);
      assert.strictEqual(urls.length, 2);
    });

    it("should handle empty urls array", async () => {
      const res = await app.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ urls: [] }),
      });

      const json = await res.json();
      assert.strictEqual(json.saved_count, 0);
    });

    it("should handle missing urls field", async () => {
      const res = await app.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });

      const json = await res.json();
      assert.strictEqual(json.saved_count, 0);
    });

    it("should skip items without url field", async () => {
      const res = await app.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          urls: [
            { url: "https://valid.com" },
            { tags: ["no-url"] },
            { url: "https://also-valid.com" },
          ],
        }),
      });

      const json = await res.json();
      assert.strictEqual(json.saved_count, 2);
    });
  });

  describe("GET /urls", () => {
    it("should return saved URLs", async () => {
      db.saveUrl(TEST_USER, "https://example.com", ["tag1"]);

      const res = await app.request("/urls", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.urls.length, 1);
      assert.strictEqual(json.urls[0].url, "https://example.com");
      assert.deepStrictEqual(json.urls[0].tags, ["tag1"]);
    });

    it("should return empty array when no URLs", async () => {
      const res = await app.request("/urls", { headers: authHeaders() });
      const json = await res.json();

      assert.deepStrictEqual(json.urls, []);
    });
  });

  describe("GET /tags", () => {
    it("should return tags sorted by frecency", async () => {
      db.saveUrl(TEST_USER, "https://example1.com", ["common"]);
      db.saveUrl(TEST_USER, "https://example2.com", ["common"]);
      db.saveUrl(TEST_USER, "https://example3.com", ["rare"]);

      const res = await app.request("/tags", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.tags[0].name, "common");
    });
  });

  describe("DELETE /urls/:id", () => {
    it("should delete a URL", async () => {
      const id = db.saveUrl(TEST_USER, "https://example.com");

      const res = await app.request(`/urls/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.deleted, true);
      assert.strictEqual(db.getSavedUrls(TEST_USER).length, 0);
    });
  });

  describe("PATCH /urls/:id/tags", () => {
    it("should update tags for a URL", async () => {
      const id = db.saveUrl(TEST_USER, "https://example.com", ["old"]);

      const res = await app.request(`/urls/${id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ tags: ["new1", "new2"] }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.updated, true);

      const urls = db.getSavedUrls(TEST_USER);
      assert.deepStrictEqual(urls[0].tags.sort(), ["new1", "new2"]);
    });
  });

  describe("POST /texts", () => {
    it("should create a text with tags", async () => {
      const res = await app.request("/texts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ content: "My note", tags: ["personal"] }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.created, true);
      assert.ok(json.id);

      const texts = db.getTexts(TEST_USER);
      assert.strictEqual(texts.length, 1);
      assert.strictEqual(texts[0].content, "My note");
    });

    it("should reject request without content", async () => {
      const res = await app.request("/texts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ tags: ["tag"] }),
      });

      assert.strictEqual(res.status, 400);
    });
  });

  describe("GET /texts", () => {
    it("should return all texts", async () => {
      db.saveText(TEST_USER, "Note 1", ["tag1"]);
      db.saveText(TEST_USER, "Note 2", ["tag2"]);

      const res = await app.request("/texts", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.texts.length, 2);
    });
  });

  describe("DELETE /texts/:id", () => {
    it("should delete a text", async () => {
      const id = db.saveText(TEST_USER, "Note to delete");

      const res = await app.request(`/texts/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(db.getTexts(TEST_USER).length, 0);
    });
  });

  describe("POST /tagsets", () => {
    it("should create a tagset", async () => {
      const res = await app.request("/tagsets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ tags: ["pushups", "10"] }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.created, true);
      assert.ok(json.id);

      const tagsets = db.getTagsets(TEST_USER);
      assert.strictEqual(tagsets.length, 1);
      assert.deepStrictEqual(tagsets[0].tags.sort(), ["10", "pushups"]);
    });

    it("should reject request without tags", async () => {
      const res = await app.request("/tagsets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 400);
    });

    it("should reject request with empty tags array", async () => {
      const res = await app.request("/tagsets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ tags: [] }),
      });

      assert.strictEqual(res.status, 400);
    });
  });

  describe("GET /tagsets", () => {
    it("should return all tagsets", async () => {
      db.saveTagset(TEST_USER, ["workout", "day1"]);
      db.saveTagset(TEST_USER, ["workout", "day2"]);

      const res = await app.request("/tagsets", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.tagsets.length, 2);
    });
  });

  describe("POST /items (unified)", () => {
    it("should create a URL item", async () => {
      const res = await app.request("/items", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ type: "url", content: "https://example.com", tags: ["web"] }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.type, "url");
      assert.strictEqual(json.created, true);
    });

    it("should create a text item", async () => {
      const res = await app.request("/items", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ type: "text", content: "A note", tags: ["note"] }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.type, "text");
    });

    it("should create a tagset item", async () => {
      const res = await app.request("/items", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ type: "tagset", tags: ["exercise", "50"] }),
      });

      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.type, "tagset");
    });

    it("should reject invalid type", async () => {
      const res = await app.request("/items", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ type: "invalid", content: "test" }),
      });

      assert.strictEqual(res.status, 400);
    });
  });

  describe("GET /items (unified)", () => {
    it("should return all items", async () => {
      db.saveUrl(TEST_USER, "https://example.com");
      db.saveText(TEST_USER, "Note");
      db.saveTagset(TEST_USER, ["tag"]);

      const res = await app.request("/items", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.items.length, 3);
    });

    it("should filter by type", async () => {
      db.saveUrl(TEST_USER, "https://example.com");
      db.saveText(TEST_USER, "Note");
      db.saveTagset(TEST_USER, ["tag"]);

      const res = await app.request("/items?type=text", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(json.items.length, 1);
      assert.strictEqual(json.items[0].type, "text");
    });
  });

  describe("DELETE /items/:id (unified)", () => {
    it("should delete any item type", async () => {
      const id = db.saveText(TEST_USER, "To delete");

      const res = await app.request(`/items/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(db.getItems(TEST_USER).length, 0);
    });
  });

  describe("Multi-user API isolation", () => {
    it("should isolate data between users via API", async () => {
      // Create second user
      const { apiKey: user2Key } = users.createUser("user2");

      // Save URL as test user
      await app.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          urls: [{ url: "https://testuser.com" }],
        }),
      });

      // Save URL as user2
      await app.request("/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user2Key}` },
        body: JSON.stringify({
          urls: [{ url: "https://user2.com" }],
        }),
      });

      // Check test user only sees their URL
      const res1 = await app.request("/urls", { headers: authHeaders() });
      const json1 = await res1.json();
      assert.strictEqual(json1.urls.length, 1);
      assert.strictEqual(json1.urls[0].url, "https://testuser.com");

      // Check user2 only sees their URL
      const res2 = await app.request("/urls", { headers: { Authorization: `Bearer ${user2Key}` } });
      const json2 = await res2.json();
      assert.strictEqual(json2.urls.length, 1);
      assert.strictEqual(json2.urls[0].url, "https://user2.com");
    });
  });
});

// Regression suite for the dropped-tombstone bug: the desktop client's
// pushSingleItem() sent `deleted_at` (snake_case) while this route destructured
// only `deletedAt` (camelCase), so every desktop deletion pushed successfully
// (200 OK) but was silently never applied. Exercises the real production app
// (`require("./index").app`, not a hand-rolled mirror) so the assertions hold
// for the actual route body-parsing, not a copy of it that could drift.
// Also covers Fix 2 (starred/archived pass-through) on the same route.
describe("POST /items — real route (dropped-tombstone regression)", () => {
  let app;
  let users;
  let apiKey;
  const TEST_USER = "realrouteuser";

  beforeEach(() => {
    // Clear every module in index.js's require closure so the fresh `app` below
    // is wired to fresh db/users/auth instances, not ones cached by an earlier
    // describe block's own db/users require-and-clear cycle. db.js is required
    // (uncached) here first, purely so index.js's own `require("./db")` picks up
    // this same fresh instance instead of requiring yet another one.
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    require("./db");
    users = require("./users");
    ({ app } = require("./index"));

    const result = users.createUser(TEST_USER);
    apiKey = result.apiKey;
  });

  function authHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  }

  // Reads back through GET /items (the same route-resolved profile bucket the
  // POST used) rather than calling db.getItems() directly — resolveProfileId()
  // maps the "default" query param to a per-user profile UUID, so a direct
  // db.getItems(userId) call (which defaults profileId to the literal string
  // "default") would silently miss the row and defeat the assertion.
  async function fetchItems(includeDeleted) {
    const path = includeDeleted ? "/items?includeDeleted=true" : "/items";
    const res = await app.request(path, { headers: authHeaders() });
    const json = await res.json();
    return json.items;
  }

  it("applies a tombstone push sent as deleted_at (snake_case) — the desktop wire spelling", async () => {
    const syncId = "desktop-tomb-snake";
    const create = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId }),
    });
    assert.strictEqual(create.status, 200);
    assert.strictEqual((await fetchItems(false)).length, 1);

    const del = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId, deleted_at: Date.now() }),
    });
    assert.strictEqual(del.status, 200);

    assert.strictEqual((await fetchItems(false)).length, 0, "the item must be soft-deleted, not left alive");
    const allItems = await fetchItems(true);
    assert.strictEqual(allItems.length, 1);
    assert.ok(allItems[0].deletedAt > 0, "deletedAt must be set from the deleted_at body field");
  });

  it("applies a tombstone push sent as deletedAt (camelCase)", async () => {
    const syncId = "desktop-tomb-camel";
    await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId }),
    });
    assert.strictEqual((await fetchItems(false)).length, 1);

    await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId, deletedAt: Date.now() }),
    });

    assert.strictEqual((await fetchItems(false)).length, 0);
    const allItems = await fetchItems(true);
    assert.ok(allItems[0].deletedAt > 0);
  });

  it("passes starred and archived through to the stored item", async () => {
    const res = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "text", content: "starred note", starred: 1, archived: 1 }),
    });
    assert.strictEqual(res.status, 200);

    const items = await fetchItems(false);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].starred, 1);
    assert.strictEqual(items[0].archived, 1);
  });

  // Every field saveItem() writes through COALESCE(?, existingColumn) is what
  // lets a client declare DATASTORE_VERSION 3 without actually carrying the
  // newer columns (packages/sync/version.js, apps/mobile/peek-core/src/types.rs):
  // POST /items defaults an absent field to null, and COALESCE leaves the
  // stored value untouched rather than nulling it out. This is the guard rail
  // for every older client re-pushing an item it doesn't know the full shape of.
  it("a partial push preserves title/domain/starred it does not send (the COALESCE guarantee older clients rely on)", async () => {
    const syncId = "partial-push-coalesce";
    const create = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        type: "url", content: "https://example.com", sync_id: syncId,
        title: "Example Domain", domain: "example.com", starred: 1,
      }),
    });
    assert.strictEqual(create.status, 200);

    // Re-push the same item as an older client would: content/type/syncId only,
    // no title/domain/starred in the body at all.
    const rePush = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId }),
    });
    assert.strictEqual(rePush.status, 200);

    const items = await fetchItems(false);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].title, "Example Domain", "title must survive a push that omits it");
    assert.strictEqual(items[0].domain, "example.com", "domain must survive a push that omits it");
    assert.strictEqual(items[0].starred, 1, "starred must survive a push that omits it");
  });

  // DOCUMENTED HAZARD, not desirable behavior — see docs/sync-coverage-gaps.md.
  // Unlike every other column, saveItem() unconditionally DELETEs item_tags and
  // rebuilds it from the pushed `tags` array, and POST /items defaults an absent
  // `tags` field to []. So an omitted `tags` field wipes the item's tag links,
  // where an omitted title/domain/starred/etc. leaves them untouched. Every
  // current client always sends a full tag list, so this is latent, not live —
  // this test pins the current behavior so a future partial-tag-push client
  // doesn't discover it by losing data.
  it("a push with no tags field wipes the item's existing tags (latent hazard, not desirable)", async () => {
    const syncId = "partial-push-tag-wipe";
    const create = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId, tags: ["a", "b"] }),
    });
    assert.strictEqual(create.status, 200);
    assert.deepStrictEqual((await fetchItems(false))[0].tags.sort(), ["a", "b"]);

    // Re-push with no `tags` field at all — POST /items defaults it to [].
    const rePush = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url", content: "https://example.com", sync_id: syncId }),
    });
    assert.strictEqual(rePush.status, 200);

    const items = await fetchItems(false);
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].tags, [], "current behavior: an omitted tags field clears existing tag links");
  });
});

// Regression suite for the empty-text sync stall: a desktop client holding an
// empty `text` item retried it every sync forever, and the item never earned
// a syncId — which stranded its events, and (while event push ran off one
// global watermark) forced every run to re-push the entire event history
// behind it (see CONTENT_REQUIRED_TYPES in index.js). `url` keeps the content
// requirement. Exercises the real
// production app (`require("./index").app`), same convention as the POST
// /items real-route suite above.
describe("POST /items — content requirement is per-type (CONTENT_REQUIRED_TYPES)", () => {
  let app;
  let users;
  let apiKey;
  const TEST_USER = "contentrequser";

  beforeEach(() => {
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    require("./db");
    users = require("./users");
    ({ app } = require("./index"));

    const result = users.createUser(TEST_USER);
    apiKey = result.apiKey;
  });

  function authHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  }

  async function fetchItems() {
    const res = await app.request("/items", { headers: authHeaders() });
    const json = await res.json();
    return json.items;
  }

  it("accepts a text item with empty-string content", async () => {
    const res = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "text", content: "" }),
    });
    assert.strictEqual(res.status, 200);

    const items = await fetchItems();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "text");
  });

  it("accepts a text item with content: null", async () => {
    const res = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "text", content: null }),
    });
    assert.strictEqual(res.status, 200);

    const items = await fetchItems();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "text");
  });

  it("accepts a text item with content omitted entirely", async () => {
    const res = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "text" }),
    });
    assert.strictEqual(res.status, 200);

    const items = await fetchItems();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, "text");
  });

  it("still rejects a url item with no content", async () => {
    const res = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "url" }),
    });
    assert.strictEqual(res.status, 400);

    const json = await res.json();
    assert.strictEqual(json.error, "content is required for type 'url'");
  });
});

// Coverage for item_events sync: append-only observations backing series/feed
// items. Exercises the real production app (`require("./index").app`), same
// convention as the POST /items real-route suite above.
describe("Event Sync Routes (POST /events, GET /events/since/:timestamp)", () => {
  let app;
  let users;
  let apiKey;
  const TEST_USER = "eventsyncuser";

  beforeEach(() => {
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    require("./db");
    users = require("./users");
    ({ app } = require("./index"));

    const result = users.createUser(TEST_USER);
    apiKey = result.apiKey;
  });

  function authHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  }

  // Creates a 'series' item through the real route and returns the server's
  // assigned id — events always reference the SERVER item id, never a
  // client-local one (see index.js's "=== Event sync endpoints ===" comment).
  async function createSeriesItem() {
    const res = await app.request("/items", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "series", metadata: { title: "Daily weight" } }),
    });
    const json = await res.json();
    return json.id;
  }

  async function pushEvents(events) {
    return app.request("/events", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ events }),
    });
  }

  async function eventsSince(timestamp) {
    const res = await app.request(`/events/since/${timestamp}`, { headers: authHeaders() });
    return res.json();
  }

  it("bulk push round-trips: all pushed events come back from a full pull", async () => {
    const itemId = await createSeriesItem();
    const events = [
      { id: "evt-1", itemId, content: null, value: 180, occurredAt: 1000, createdAt: 1000, metadata: { unit: "lb" } },
      { id: "evt-2", itemId, content: null, value: 179, occurredAt: 2000, createdAt: 2000, metadata: { unit: "lb" } },
      { id: "evt-3", itemId, content: null, value: 178, occurredAt: 3000, createdAt: 3000, metadata: { unit: "lb" } },
    ];

    const pushRes = await pushEvents(events);
    assert.strictEqual(pushRes.status, 200);
    const pushJson = await pushRes.json();
    assert.strictEqual(pushJson.received, 3);
    assert.strictEqual(pushJson.saved, 3);

    const { events: pulled } = await eventsSince(0);
    assert.strictEqual(pulled.length, 3);
    const byId = Object.fromEntries(pulled.map((e) => [e.id, e]));
    assert.strictEqual(byId["evt-1"].value, 180);
    assert.strictEqual(byId["evt-1"].itemId, itemId);
    assert.deepStrictEqual(byId["evt-1"].metadata, { unit: "lb" });
    assert.strictEqual(byId["evt-3"].value, 178);
  });

  it("incremental pull returns only events created after the given timestamp", async () => {
    const itemId = await createSeriesItem();
    await pushEvents([
      { id: "old-evt", itemId, value: 1, occurredAt: 1000, createdAt: 1000 },
      { id: "new-evt", itemId, value: 2, occurredAt: 5000, createdAt: 5000 },
    ]);

    const { events: sinceMid } = await eventsSince(3000);
    assert.strictEqual(sinceMid.length, 1);
    assert.strictEqual(sinceMid[0].id, "new-evt");

    const { events: sinceAll } = await eventsSince(0);
    assert.strictEqual(sinceAll.length, 2);

    const { events: sinceFuture } = await eventsSince(9999);
    assert.strictEqual(sinceFuture.length, 0);
  });

  it("re-pushing the same event id is idempotent — never duplicates", async () => {
    const itemId = await createSeriesItem();
    const event = { id: "dupe-evt", itemId, value: 42, occurredAt: 1000, createdAt: 1000 };

    const first = await pushEvents([event]);
    assert.strictEqual((await first.json()).saved, 1);

    // Re-push the identical event, as a retried/overlapping sync run would.
    const second = await pushEvents([event]);
    const secondJson = await second.json();
    assert.strictEqual(secondJson.received, 1);
    assert.strictEqual(secondJson.saved, 0, "a duplicate id must not be counted as newly saved");

    const { events } = await eventsSince(0);
    assert.strictEqual(events.length, 1, "the store must still hold exactly one row for this id");
  });

  it("a series item restores WITH its events (not just as an empty shell)", async () => {
    const itemId = await createSeriesItem();
    await pushEvents([
      { id: "obs-1", itemId, value: 100, occurredAt: 1000, createdAt: 1000 },
      { id: "obs-2", itemId, value: 101, occurredAt: 2000, createdAt: 2000 },
    ]);

    // Simulate a fresh device restoring from the server: pull the item, then
    // pull its events and confirm they reference the item that came back.
    const itemsRes = await app.request("/items", { headers: authHeaders() });
    const { items } = await itemsRes.json();
    const series = items.find((i) => i.id === itemId);
    assert.ok(series, "the series item itself must come back");
    assert.strictEqual(series.type, "series");

    const { events } = await eventsSince(0);
    const seriesEvents = events.filter((e) => e.itemId === series.id);
    assert.strictEqual(seriesEvents.length, 2, "restoring the series item must bring its observations with it");
  });

  it("merge is order-independent: pushing events out of chronological order still yields a complete, correctly-ordered pull", async () => {
    const itemId = await createSeriesItem();

    // Push the newest event FIRST, then backfill older ones in a second,
    // separate request — mirrors two out-of-order sync runs (or a retry that
    // interleaves with a newer push) landing in the opposite order they
    // occurred.
    await pushEvents([{ id: "late-arriving-old", itemId, value: 1, occurredAt: 1000, createdAt: 1000 }]);
    await pushEvents([
      { id: "newest", itemId, value: 3, occurredAt: 3000, createdAt: 3000 },
      { id: "middle", itemId, value: 2, occurredAt: 2000, createdAt: 2000 },
    ]);

    const { events } = await eventsSince(0);
    assert.strictEqual(events.length, 3);
    // getEventsSince() orders by createdAt regardless of push order.
    assert.deepStrictEqual(events.map((e) => e.id), ["late-arriving-old", "middle", "newest"]);
  });

  it("rejects an empty events array", async () => {
    const res = await pushEvents([]);
    assert.strictEqual(res.status, 400);
  });

  it("rejects an event missing required fields", async () => {
    const res = await pushEvents([{ id: "incomplete" }]);
    assert.strictEqual(res.status, 400);
  });
});

describe("Tag Sync Routes (POST /tags, GET /tags/since/:timestamp)", () => {
  let app;
  let users;
  let apiKey;
  const TEST_USER = "tagsyncuser";

  beforeEach(() => {
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    require("./db");
    users = require("./users");
    ({ app } = require("./index"));

    const result = users.createUser(TEST_USER);
    apiKey = result.apiKey;
  });

  function authHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  }

  async function pushTags(tags) {
    return app.request("/tags", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ tags }),
    });
  }

  async function tagsSince(timestamp) {
    const res = await app.request(`/tags/since/${timestamp}`, { headers: authHeaders() });
    return res.json();
  }

  it("a tag pushes its color, description, and metadata, and a pull applies them", async () => {
    const pushRes = await pushTags([
      { name: "reading", color: "#00aaff", description: "Books and articles", metadata: { icon: "book" }, createdAt: 1000, updatedAt: 1000 },
    ]);
    assert.strictEqual(pushRes.status, 200);
    const pushJson = await pushRes.json();
    assert.strictEqual(pushJson.saved, 1);

    const { tags } = await tagsSince(0);
    assert.strictEqual(tags.length, 1);
    assert.strictEqual(tags[0].name, "reading");
    assert.strictEqual(tags[0].color, "#00aaff");
    assert.strictEqual(tags[0].description, "Books and articles");
    assert.deepStrictEqual(tags[0].metadata, { icon: "book" });
  });

  it("a parent arriving after its child in the same push still resolves by name on pull", async () => {
    await pushTags([
      { name: "child", parentId: "parent", createdAt: 1000, updatedAt: 1000 },
      { name: "parent", createdAt: 1000, updatedAt: 1000 },
    ]);

    const { tags } = await tagsSince(0);
    const child = tags.find((t) => t.name === "child");
    assert.strictEqual(child.parentId, "parent");
    assert.ok(tags.some((t) => t.name === "parent"), "the parent tag itself must also come back");
  });

  it("incremental pull returns only tags updated after the given timestamp", async () => {
    await pushTags([
      { name: "old-tag", createdAt: 1000, updatedAt: 1000 },
      { name: "new-tag", createdAt: 5000, updatedAt: 5000 },
    ]);

    const { tags: sinceMid } = await tagsSince(3000);
    assert.strictEqual(sinceMid.length, 1);
    assert.strictEqual(sinceMid[0].name, "new-tag");
  });

  it("a failed push does not save any tag past the point of failure — retried tags are idempotent", async () => {
    // The route itself doesn't partially fail mid-array (saveTags runs in one
    // transaction), but a re-push of the same tag must still be a no-op that
    // doesn't double count, the same guarantee events rely on for retry safety.
    const tag = { name: "retry-me", color: "#111111", createdAt: 1000, updatedAt: 1000 };
    const first = await pushTags([tag]);
    assert.strictEqual((await first.json()).saved, 1);

    const second = await pushTags([tag]);
    const secondJson = await second.json();
    assert.strictEqual(secondJson.saved, 0, "an unchanged updatedAt must not be re-saved");

    const { tags } = await tagsSince(0);
    assert.strictEqual(tags.filter((t) => t.name === "retry-me").length, 1);
  });

  it("rejects an empty tags array", async () => {
    const res = await pushTags([]);
    assert.strictEqual(res.status, 400);
  });

  it("rejects a tag missing required fields", async () => {
    const res = await pushTags([{ color: "#000000" }]);
    assert.strictEqual(res.status, 400);
  });
});

// Regression suite for the cross-profile data-leak bug.
//
// The bug: resolveProfileId() used to SILENTLY fall back to the "default"
// profile whenever it received a valid-format profile UUID it hadn't seen
// before. Because every /items route resolves
//   resolveProfileId(userId, c.req.query("profile") || "default")
// and getConnection() keys the SQLite file by userId:profileId, the fallback
// collapsed every unseen profile onto the single "default" bucket — so two
// distinct profiles read and wrote each other's items.
//
// These tests wire a profile-aware app exactly like index.js (resolve the
// ?profile= query param through users.resolveProfileId before hitting db) and
// assert that distinct, never-registered profile identifiers stay isolated.
describe("Profile Isolation (data-leak regression)", () => {
  let app;
  let db;
  let users;
  let TEST_API_KEY;
  const TEST_USER = "isouser";

  const UUID_A = "11111111-1111-4111-8111-111111111111";
  const UUID_B = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    cleanTestDir();

    db = require("./db");
    users = require("./users");

    const result = users.createUser(TEST_USER);
    TEST_API_KEY = result.apiKey;

    const { Hono } = require("hono");
    app = new Hono();

    app.use("*", async (c, next) => {
      const auth = c.req.header("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const userId = users.getUserIdFromApiKey(auth.slice(7));
      if (!userId) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.set("userId", userId);
      return next();
    });

    // Wired identically to index.js: profile query param -> resolveProfileId.
    app.post("/items", async (c) => {
      const userId = c.get("userId");
      const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
      const body = await c.req.json();
      const { type, content, tags = [] } = body;
      const id = db.saveItem(userId, type, content || null, tags, null, null, profileId);
      return c.json({ id, created: true });
    });
    app.get("/items", (c) => {
      const userId = c.get("userId");
      const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
      const items = db.getItems(userId, c.req.query("type") || null, profileId);
      return c.json({ items });
    });
  });

  after(() => {
    if (db && db.closeAllConnections) db.closeAllConnections();
    if (users && users.closeSystemDb) users.closeSystemDb();
    cleanTestDir();
  });

  it("an unknown profile UUID must NOT see another profile's items", async () => {
    // Save an item under profile A.
    await app.request("/items?profile=" + UUID_A, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({ type: "url", content: "https://profile-a-secret.com" }),
    });

    // GET items under a DIFFERENT, never-registered profile B.
    const res = await app.request("/items?profile=" + UUID_B, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    const json = await res.json();

    // Before the fix this returned A's item (both collapsed onto "default").
    assert.strictEqual(
      json.items.length,
      0,
      "profile B must not see profile A's items"
    );
  });

  it("two distinct unknown UUIDs must not see each other's items", async () => {
    await app.request("/items?profile=" + UUID_A, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({ type: "url", content: "https://a.com" }),
    });
    await app.request("/items?profile=" + UUID_B, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({ type: "url", content: "https://b.com" }),
    });

    const resA = await app.request("/items?profile=" + UUID_A, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    const jsonA = await resA.json();
    assert.strictEqual(jsonA.items.length, 1);
    assert.strictEqual(jsonA.items[0].content, "https://a.com");

    const resB = await app.request("/items?profile=" + UUID_B, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    const jsonB = await resB.json();
    assert.strictEqual(jsonB.items.length, 1);
    assert.strictEqual(jsonB.items[0].content, "https://b.com");
  });

  it("an unknown UUID must not inherit the default bucket's data", async () => {
    // Write under the explicit "default" profile.
    await app.request("/items?profile=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({ type: "url", content: "https://default-data.com" }),
    });

    // An unknown UUID must get its own empty bucket, not default's data.
    const res = await app.request("/items?profile=" + UUID_A, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    const json = await res.json();
    assert.strictEqual(json.items.length, 0, "unknown UUID must not inherit default's data");
  });

  it("resolveProfileId is stable: same UUID resolves to the same bucket twice", () => {
    const first = users.resolveProfileId(TEST_USER, UUID_A);
    const second = users.resolveProfileId(TEST_USER, UUID_A);
    assert.strictEqual(first, UUID_A, "resolved id should equal the passed UUID");
    assert.strictEqual(first, second, "must resolve stably");
  });

  it("createProfileWithId is idempotent and uses the passed-in id", () => {
    const p1 = users.createProfileWithId(TEST_USER, UUID_B, "Imported");
    assert.strictEqual(p1.id, UUID_B);
    const p2 = users.createProfileWithId(TEST_USER, UUID_B, "Imported");
    assert.strictEqual(p2.id, UUID_B, "second call returns the same profile");
    assert.strictEqual(p1.slug, p2.slug, "slug stable across idempotent calls");
  });

  it("an unknown non-default legacy slug does not collapse onto default", () => {
    const defaultId = users.resolveProfileId(TEST_USER, "default");
    const workId = users.resolveProfileId(TEST_USER, "work");
    assert.notStrictEqual(workId, defaultId, "'work' slug must not share default's bucket");
    // Stable on re-resolve.
    assert.strictEqual(users.resolveProfileId(TEST_USER, "work"), workId);
  });
});

describe("MCP Grant Auth Middleware Tests", () => {
  // Exercises the real production middleware (auth.js createAuthMiddleware /
  // createMcpAuthMiddleware) wired the same way index.js wires them: the
  // general auth gate first, then the /mcp/* grant gate layered on top. This
  // is what proves the two separation rules from design doc §4.1 — a device
  // key must be refused on /mcp/*, and a grant key must be refused on the
  // sync routes — hold for the actual auth code, not a re-implementation of it.
  let app;
  let users;
  let grants;
  let TEST_DEVICE_KEY;
  let TEST_GRANT_KEY;
  let TEST_READONLY_GRANT_KEY;
  const TEST_USER = "mcpauthuser";

  beforeEach(() => {
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./grants")];
    delete require.cache[require.resolve("./auth")];
    cleanTestDir();

    users = require("./users");
    grants = require("./grants");
    const { createAuthMiddleware, createMcpAuthMiddleware } = require("./auth");

    users.createUser(TEST_USER);
    const device = users.createDevice(TEST_USER, "test-device");
    TEST_DEVICE_KEY = device.apiKey;

    const grant = grants.createGrant(TEST_USER, "test-grant", "work", false, "profile-a");
    TEST_GRANT_KEY = grant.apiKey;

    const roGrant = grants.createGrant(TEST_USER, "readonly-grant", "", true, "profile-a");
    TEST_READONLY_GRANT_KEY = roGrant.apiKey;

    const { Hono } = require("hono");
    app = new Hono();

    // Mirrors index.js: the general auth middleware runs on every path (and
    // skips /mcp itself), then the grant gate is layered on /mcp/*.
    app.use("*", createAuthMiddleware({ mode: "multi-user" }));
    app.use("/mcp/*", createMcpAuthMiddleware());

    // Stand-in for a sync route (e.g. GET /items).
    app.get("/items", (c) => c.json({ userId: c.get("userId") }));

    // Mirrors index.js's GET /mcp/whoami probe.
    app.get("/mcp/whoami", (c) => c.json({
      userId: c.get("userId"),
      scopeTag: c.get("scopeTag"),
      readonly: c.get("readonly"),
      profileId: c.get("profileId"),
    }));
  });

  after(() => {
    if (users && users.closeSystemDb) users.closeSystemDb();
    cleanTestDir();
  });

  it("resolves a grant key on /mcp/* with its scope, readonly bit, and profile", async () => {
    const res = await app.request("/mcp/whoami", {
      headers: { Authorization: `Bearer ${TEST_GRANT_KEY}` },
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.userId, TEST_USER);
    assert.strictEqual(json.scopeTag, "work");
    assert.strictEqual(json.readonly, false);
    assert.strictEqual(json.profileId, "profile-a");
  });

  it("reflects an unscoped, readonly grant", async () => {
    const res = await app.request("/mcp/whoami", {
      headers: { Authorization: `Bearer ${TEST_READONLY_GRANT_KEY}` },
    });
    const json = await res.json();
    assert.strictEqual(json.scopeTag, "");
    assert.strictEqual(json.readonly, true);
  });

  it("a device key must be refused on /mcp/* (separation rule)", async () => {
    const res = await app.request("/mcp/whoami", {
      headers: { Authorization: `Bearer ${TEST_DEVICE_KEY}` },
    });
    assert.strictEqual(res.status, 401);
  });

  it("a grant key must be refused on the sync routes (separation rule)", async () => {
    const res = await app.request("/items", {
      headers: { Authorization: `Bearer ${TEST_GRANT_KEY}` },
    });
    assert.strictEqual(res.status, 401);
  });

  it("a device key still authenticates the sync routes", async () => {
    const res = await app.request("/items", {
      headers: { Authorization: `Bearer ${TEST_DEVICE_KEY}` },
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.userId, TEST_USER);
  });

  it("rejects a revoked grant on /mcp/*", async () => {
    const g = grants.createGrant(TEST_USER, "throwaway", "x", false, "p");
    grants.revokeGrant(TEST_USER, g.grantId);
    const res = await app.request("/mcp/whoami", {
      headers: { Authorization: `Bearer ${g.apiKey}` },
    });
    assert.strictEqual(res.status, 401);
  });

  it("rejects /mcp/* with no Authorization header", async () => {
    const res = await app.request("/mcp/whoami");
    assert.strictEqual(res.status, 401);
  });

  it("rejects /mcp/* with an unknown key", async () => {
    const res = await app.request("/mcp/whoami", {
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    assert.strictEqual(res.status, 401);
  });
});

describe("MCP Grant Admin Routes Tests", () => {
  // Exercises the real /admin/mcp-grants routes, wired the same way index.js
  // wires them (ADMIN_TOKEN gate, then the route handlers calling grants.js).
  let app;
  let users;
  let grants;
  const ADMIN_TOKEN = "test-admin-token-fixture";
  const TEST_USER = "mcpadminuser";

  beforeEach(() => {
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./grants")];
    cleanTestDir();

    users = require("./users");
    grants = require("./grants");
    users.createUser(TEST_USER);

    const { Hono } = require("hono");
    const crypto = require("crypto");
    app = new Hono();

    // Mirrors index.js's adminTokenMatches gate.
    app.use("/admin/*", async (c, next) => {
      const auth = c.req.header("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const a = Buffer.from(token);
      const b = Buffer.from(ADMIN_TOKEN);
      const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!matches) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return next();
    });

    app.post("/admin/mcp-grants", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const { userId, label, scopeTag, readonly, profileId } = body;
      if (!userId || !label || typeof scopeTag !== "string" || !profileId) {
        return c.json({ error: "userId, label, scopeTag, and profileId are required" }, 400);
      }
      try {
        const grant = grants.createGrant(userId, label, scopeTag, !!readonly, profileId);
        return c.json({ grant });
      } catch (e) {
        return c.json({ error: e.message }, 400);
      }
    });

    app.get("/admin/mcp-grants", (c) => {
      const userId = c.req.query("userId");
      if (!userId) {
        return c.json({ error: "userId query param is required" }, 400);
      }
      return c.json({ grants: grants.listGrants(userId) });
    });

    app.delete("/admin/mcp-grants/:grantId", (c) => {
      const userId = c.req.query("userId");
      const grantId = c.req.param("grantId");
      if (!userId) {
        return c.json({ error: "userId query param is required" }, 400);
      }
      try {
        const revoked = grants.revokeGrant(userId, grantId);
        return c.json({ revoked });
      } catch (e) {
        return c.json({ error: e.message }, 400);
      }
    });
  });

  after(() => {
    if (users && users.closeSystemDb) users.closeSystemDb();
    cleanTestDir();
  });

  function adminHeaders() {
    return { Authorization: `Bearer ${ADMIN_TOKEN}` };
  }

  it("rejects an unauthenticated mint", async () => {
    const res = await app.request("/admin/mcp-grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER, label: "x", scopeTag: "work", readonly: false, profileId: "p" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("mints a grant and returns the raw key exactly once", async () => {
    const res = await app.request("/admin/mcp-grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ userId: TEST_USER, label: "nightly agent", scopeTag: "work", readonly: false, profileId: "profile-a" }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(json.grant.apiKey, "mint response should carry the raw key");
    assert.strictEqual(json.grant.scopeTag, "work");
    assert.strictEqual(json.grant.readonly, false);
    assert.strictEqual(json.grant.profileId, "profile-a");
  });

  it("never returns a raw key from the list route", async () => {
    await app.request("/admin/mcp-grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ userId: TEST_USER, label: "a", scopeTag: "work", readonly: false, profileId: "p" }),
    });

    const res = await app.request(`/admin/mcp-grants?userId=${TEST_USER}`, {
      headers: adminHeaders(),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.grants.length, 1);
    assert.strictEqual(json.grants[0].apiKey, undefined);
    assert.strictEqual(json.grants[0].key_hash, undefined);
    assert.strictEqual(json.grants[0].keyHash, undefined);
  });

  it("revokes a grant so it stops resolving", async () => {
    const mintRes = await app.request("/admin/mcp-grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ userId: TEST_USER, label: "a", scopeTag: "work", readonly: false, profileId: "p" }),
    });
    const { grant } = await mintRes.json();

    const delRes = await app.request(`/admin/mcp-grants/${grant.grantId}?userId=${TEST_USER}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    assert.strictEqual(delRes.status, 200);
    const delJson = await delRes.json();
    assert.strictEqual(delJson.revoked, true);

    assert.deepStrictEqual(grants.resolveMcpGrant(grant.apiKey), { revoked: true });
  });
});

describe("MCP Item Routes Tests", () => {
  // Exercises the real mcp-items.js business logic (queryItems/searchItems/
  // resolveItemId/getItemForRoute) through a Hono app wired the same way
  // index.js wires the /mcp/* routes: general auth (skips /mcp), then the
  // grant gate, then thin handlers that read scope/profile/user from the
  // grant context set on `c` — never from the request. This is the READ
  // half of design doc §3.3 (GET /mcp/items, /items/search,
  // /items/:idOrPrefix, /items/resolve, /session).
  let app;
  let db;
  let users;
  let grants;
  let mcpItemsMod;
  let SCOPED_GRANT_KEY;
  let UNSCOPED_GRANT_KEY;
  const TEST_USER = "mcpitemsuser";
  const PROFILE = "profile-a";

  function insertItem(conn, { id, type = "text", content = "", title = "", domain = "", tags = [], syncId = "" }) {
    const crypto = require("crypto");
    const now = Date.now();
    conn.run(
      `INSERT INTO items (id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt, createdByDevice, title, domain, frecencyScore, starred, archived)
       VALUES (?, ?, ?, NULL, ?, 0, ?, ?, 0, '', ?, ?, 0, 0, 0)`,
      [id, type, content, syncId, now, now, title, domain]
    );
    for (const tagName of tags) {
      const existing = conn.get("SELECT id FROM tags WHERE name = ?", [tagName]);
      const tagId = existing ? existing.id : crypto.randomUUID();
      if (!existing) {
        conn.run(
          "INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt) VALUES (?, ?, 1, ?, 0, ?, ?)",
          [tagId, tagName, now, now, now]
        );
      }
      conn.run("INSERT OR IGNORE INTO item_tags (itemId, tagId, createdAt) VALUES (?, ?, ?)", [id, tagId, now]);
    }
  }

  beforeEach(() => {
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./grants")];
    delete require.cache[require.resolve("./auth")];
    delete require.cache[require.resolve("./mcp-items")];
    cleanTestDir();

    db = require("./db");
    users = require("./users");
    grants = require("./grants");
    mcpItemsMod = require("./mcp-items");
    const { createAuthMiddleware, createMcpAuthMiddleware } = require("./auth");
    const { DATASTORE_VERSION } = require("./version");

    users.createUser(TEST_USER);
    const scopedGrant = grants.createGrant(TEST_USER, "scoped", "work", false, PROFILE);
    SCOPED_GRANT_KEY = scopedGrant.apiKey;
    const unscopedGrant = grants.createGrant(TEST_USER, "unscoped", "", false, PROFILE);
    UNSCOPED_GRANT_KEY = unscopedGrant.apiKey;

    const { Hono } = require("hono");
    app = new Hono();
    app.use("*", createAuthMiddleware({ mode: "multi-user" }));
    app.use("/mcp/*", createMcpAuthMiddleware());

    // Mirrors index.js's GET /mcp/items* wiring — same mcp-items.js calls,
    // same "scope/profile/user come only from the grant context" rule.
    app.get("/mcp/items", (c) => {
      const items = mcpItemsMod.queryItems(c.get("userId"), c.get("profileId"), c.get("scopeTag"), {
        tags: c.req.query("tags") ? c.req.query("tags").split(",") : undefined,
        type: c.req.query("type") || undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
        sort: c.req.query("sort") || undefined,
      });
      return c.json({ items });
    });
    app.get("/mcp/items/search", (c) => {
      const items = mcpItemsMod.searchItems(c.get("userId"), c.get("profileId"), c.get("scopeTag"), {
        query: c.req.query("q") || "",
        tags: c.req.query("tags") ? c.req.query("tags").split(",") : undefined,
        type: c.req.query("type") || undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
      });
      return c.json({ items });
    });
    app.get("/mcp/items/resolve", (c) => {
      const result = mcpItemsMod.resolveItemId(
        c.get("userId"),
        c.get("profileId"),
        c.get("scopeTag"),
        c.req.query("prefix") || ""
      );
      return c.json(result);
    });
    app.get("/mcp/items/:idOrPrefix", (c) => {
      const result = mcpItemsMod.getItemForRoute(
        c.get("userId"),
        c.get("profileId"),
        c.get("scopeTag"),
        c.req.param("idOrPrefix"),
        {
          maxContentLength: c.req.query("maxContentLength") ? Number(c.req.query("maxContentLength")) : undefined,
          contentOffset: c.req.query("contentOffset") ? Number(c.req.query("contentOffset")) : undefined,
          events: c.req.query("events") ? Number(c.req.query("events")) : undefined,
        }
      );
      if (result.status === "ambiguous") {
        return c.json({ id: null, ambiguous: true, candidates: result.candidates, truncated: result.truncated }, 409);
      }
      if (result.status === "not_found") {
        return c.json({ error: "item not found" }, 404);
      }
      return c.json({ item: result.item });
    });
    app.get("/mcp/session", (c) => {
      return c.json({
        scopeTag: c.get("scopeTag"),
        readonly: c.get("readonly"),
        profileId: c.get("profileId"),
        datastoreVersion: DATASTORE_VERSION,
        userId: c.get("userId"),
      });
    });
  });

  after(() => {
    if (db && db.closeAllConnections) db.closeAllConnections();
    if (users && users.closeSystemDb) users.closeSystemDb();
    cleanTestDir();
  });

  function scopedHeaders() {
    return { Authorization: `Bearer ${SCOPED_GRANT_KEY}` };
  }
  function unscopedHeaders() {
    return { Authorization: `Bearer ${UNSCOPED_GRANT_KEY}` };
  }

  it("GET /mcp/session reports scope/readonly/profile/user from the grant, ignoring anything on the request", async () => {
    const res = await app.request("/mcp/session?scopeTag=whatever&userId=someone-else", { headers: scopedHeaders() });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.scopeTag, "work");
    assert.strictEqual(json.readonly, false);
    assert.strictEqual(json.profileId, PROFILE);
    assert.strictEqual(json.userId, TEST_USER);
    assert.strictEqual(typeof json.datastoreVersion, "number");
  });

  describe("scope confinement is a WHERE clause, not a post-filter", () => {
    it("LIMIT/OFFSET count only in-scope rows — a scoped grant cannot page past its scope", async () => {
      db.saveItem(TEST_USER, "text", "in-scope-1", ["work"], null, null, PROFILE, null, "", "In scope 1");
      db.saveItem(TEST_USER, "text", "in-scope-2", ["work"], null, null, PROFILE, null, "", "In scope 2");
      db.saveItem(TEST_USER, "text", "out-of-scope-a", ["personal"], null, null, PROFILE, null, "", "Out A");
      db.saveItem(TEST_USER, "text", "out-of-scope-b", ["personal"], null, null, PROFILE, null, "", "Out B");
      db.saveItem(TEST_USER, "text", "out-of-scope-c", [], null, null, PROFILE, null, "", "Out C");

      const page0 = await app.request("/mcp/items?limit=1&offset=0&sort=recent", { headers: scopedHeaders() });
      const page1 = await app.request("/mcp/items?limit=1&offset=1&sort=recent", { headers: scopedHeaders() });
      const page2 = await app.request("/mcp/items?limit=1&offset=2&sort=recent", { headers: scopedHeaders() });

      const j0 = await page0.json();
      const j1 = await page1.json();
      const j2 = await page2.json();

      assert.strictEqual(j0.items.length, 1);
      assert.strictEqual(j1.items.length, 1);
      // Offset 2 is past both in-scope rows: must be empty. If scope were a
      // post-filter applied after LIMIT/OFFSET, this offset would still
      // land inside the unfiltered 5-row window and could return a
      // (wrongly exposed) out-of-scope row instead of nothing.
      assert.strictEqual(j2.items.length, 0);

      const titles = [j0.items[0].title, j1.items[0].title].sort();
      assert.deepStrictEqual(titles, ["In scope 1", "In scope 2"]);
    });

    it("scope also confines the tags-filter branch (GROUP BY … HAVING all-tags-match)", async () => {
      db.saveItem(TEST_USER, "text", "tagged-in-scope", ["work", "todo"], null, null, PROFILE, null, "", "Tagged in scope");
      db.saveItem(TEST_USER, "text", "tagged-out-of-scope", ["personal", "todo"], null, null, PROFILE, null, "", "Tagged out of scope");

      const res = await app.request("/mcp/items?tags=todo", { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.items.length, 1);
      assert.strictEqual(json.items[0].title, "Tagged in scope");
    });

    it("an unscoped grant sees all items, confirming scope is what narrowed the scoped grant's query", async () => {
      db.saveItem(TEST_USER, "text", "x-item", ["work"], null, null, PROFILE, null, "", "A");
      db.saveItem(TEST_USER, "text", "y-item", ["personal"], null, null, PROFILE, null, "", "B");

      const res = await app.request("/mcp/items?limit=10", { headers: unscopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.items.length, 2);
    });

    it("search_items confines candidates by scope before ranking/paging", async () => {
      db.saveItem(TEST_USER, "text", "widget shopping list one", ["work"], null, null, PROFILE, null, "", "Widget note");
      db.saveItem(TEST_USER, "text", "widget shopping list two", ["personal"], null, null, PROFILE, null, "", "Widget note");

      const res = await app.request("/mcp/items/search?q=widget", { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.items.length, 1);
      assert.deepStrictEqual(json.items[0].tags, ["work"]);
    });
  });

  describe("a prefix matching only out-of-scope items reads as not-found", () => {
    it("resolve returns {id:null} identically for a truly-missing prefix and an out-of-scope one", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "outscope-aaa111", title: "Secret", tags: ["personal"] });

      const missing = await app.request("/mcp/items/resolve?prefix=zzz-nope", { headers: scopedHeaders() });
      const outOfScope = await app.request("/mcp/items/resolve?prefix=outscope-", { headers: scopedHeaders() });

      assert.deepStrictEqual(await missing.json(), { id: null });
      assert.deepStrictEqual(await outOfScope.json(), { id: null });
    });

    it("GET /mcp/items/:id returns 404 for an out-of-scope item's exact id, same as a nonexistent id", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "outscope-exact-id", title: "Secret", tags: ["personal"] });

      const outOfScope = await app.request("/mcp/items/outscope-exact-id", { headers: scopedHeaders() });
      const missing = await app.request("/mcp/items/does-not-exist-at-all", { headers: scopedHeaders() });

      assert.strictEqual(outOfScope.status, 404);
      assert.strictEqual(missing.status, 404);
      assert.deepStrictEqual(await outOfScope.json(), await missing.json());
    });

    it("an unscoped grant CAN resolve the same id (confirms scope, not the id, hides it)", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "outscope-visible-unscoped", title: "Secret", tags: ["personal"] });

      const res = await app.request("/mcp/items/resolve?prefix=outscope-visible-unscoped", { headers: unscopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.id, "outscope-visible-unscoped");
    });
  });

  describe("ambiguity payload never names an out-of-scope id or title", () => {
    it("resolve's candidates list is built only from in-scope rows sharing the prefix", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "dupe-in-scope-1", title: "In scope A", tags: ["work"] });
      insertItem(conn, { id: "dupe-in-scope-2", title: "In scope B", tags: ["work"] });
      insertItem(conn, { id: "dupe-out-of-scope-3", title: "TOP SECRET", tags: ["personal"] });

      const res = await app.request("/mcp/items/resolve?prefix=dupe-", { headers: scopedHeaders() });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.ambiguous, true);
      const ids = json.candidates.map((c) => c.id).sort();
      assert.deepStrictEqual(ids, ["dupe-in-scope-1", "dupe-in-scope-2"]);
      const titles = json.candidates.map((c) => c.title);
      assert.ok(!titles.includes("TOP SECRET"), "ambiguity payload must never name an out-of-scope title");
      assert.ok(!json.candidates.some((c) => c.id === "dupe-out-of-scope-3"), "ambiguity payload must never name an out-of-scope id");
    });

    it("GET /mcp/items/:idOrPrefix surfaces the same scope-confined candidate list as a 409", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "amb-in-scope-1", title: "One", tags: ["work"] });
      insertItem(conn, { id: "amb-in-scope-2", title: "Two", tags: ["work"] });
      insertItem(conn, { id: "amb-out-of-scope-3", title: "Hidden", tags: ["personal"] });

      const res = await app.request("/mcp/items/amb-", { headers: scopedHeaders() });
      assert.strictEqual(res.status, 409);
      const json = await res.json();
      assert.strictEqual(json.ambiguous, true);
      assert.ok(!json.candidates.some((c) => c.title === "Hidden" || c.id === "amb-out-of-scope-3"));
    });
  });

  describe("id-namespace resolution (design doc §5)", () => {
    it("resolves an item by its desktop-side syncId, not just its server id", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "server-minted-uuid-1", title: "Pushed item", tags: ["work"], syncId: "desktop-local-id-1" });

      const res = await app.request("/mcp/items/resolve?prefix=desktop-local-id-1", { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.id, "server-minted-uuid-1");
    });

    it("every returned item carries localId alongside id", async () => {
      const conn = db.getConnection(TEST_USER, PROFILE);
      insertItem(conn, { id: "server-id-2", title: "Pushed 2", tags: ["work"], syncId: "desktop-id-2" });

      const res = await app.request("/mcp/items/server-id-2", { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.item.id, "server-id-2");
      assert.strictEqual(json.item.localId, "desktop-id-2");
    });
  });

  describe("get_item content windowing and events", () => {
    it("windows content by default and reports contentLength/contentTruncated", async () => {
      const longContent = "x".repeat(5000);
      const id = db.saveItem(TEST_USER, "text", longContent, ["work"], null, null, PROFILE, null, "", "Long item");
      const res = await app.request(`/mcp/items/${id}`, { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.item.content.length, 4000);
      assert.strictEqual(json.item.contentLength, 5000);
      assert.strictEqual(json.item.contentTruncated, true);
    });

    it("maxContentLength=-1 returns the whole thing", async () => {
      const longContent = "y".repeat(5000);
      const id = db.saveItem(TEST_USER, "text", longContent, ["work"], null, null, PROFILE, null, "", "Long item 2");
      const res = await app.request(`/mcp/items/${id}?maxContentLength=-1`, { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.item.content.length, 5000);
      assert.strictEqual(json.item.contentTruncated, undefined);
    });

    it("events param attaches the item's event history", async () => {
      const id = db.saveItem(TEST_USER, "text", "task body", ["work", "todo"], null, null, PROFILE, null, "", "A task");
      const conn = db.getConnection(TEST_USER, PROFILE);
      conn.run(
        `INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt) VALUES (?, ?, 'started', 0, ?, '{}', ?)`,
        ["evt-1", id, Date.now(), Date.now()]
      );
      const res = await app.request(`/mcp/items/${id}?events=20`, { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.item.events.length, 1);
      assert.strictEqual(json.item.events[0].type, "started");
    });

    it("get_item omits events when the events param is absent", async () => {
      const id = db.saveItem(TEST_USER, "text", "no events here", ["work"], null, null, PROFILE, null, "", "Plain item");
      const res = await app.request(`/mcp/items/${id}`, { headers: scopedHeaders() });
      const json = await res.json();
      assert.strictEqual(json.item.events, undefined);
    });
  });
});

describe("MCP Item Write Routes Tests", () => {
  // Exercises the real mcp-items.js write-side business logic (createItem/
  // updateItem/deleteItem/tagItem/untagItem/recordEvent/completeTask/listTags)
  // through a Hono app wired the same way index.js wires the /mcp/* write
  // routes: general auth (skips /mcp), the grant gate, a readonly check read
  // only from the grant context, then thin handlers translating mcp-items.js
  // {status,...} results into HTTP. This is the WRITE half of design doc
  // §3.3, and the five behaviours design doc §4.1 exists to guarantee.
  let app;
  let db;
  let users;
  let grants;
  let mcpItemsMod;
  let SCOPED_KEY;
  let READONLY_KEY;
  let UNSCOPED_KEY;
  const TEST_USER = "mcpwriteuser";
  const PROFILE = "profile-w";

  beforeEach(() => {
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./grants")];
    delete require.cache[require.resolve("./auth")];
    delete require.cache[require.resolve("./mcp-items")];
    cleanTestDir();

    db = require("./db");
    users = require("./users");
    grants = require("./grants");
    mcpItemsMod = require("./mcp-items");
    const { createAuthMiddleware, createMcpAuthMiddleware } = require("./auth");

    users.createUser(TEST_USER);
    SCOPED_KEY = grants.createGrant(TEST_USER, "scoped-write", "work", false, PROFILE).apiKey;
    READONLY_KEY = grants.createGrant(TEST_USER, "readonly-write", "work", true, PROFILE).apiKey;
    UNSCOPED_KEY = grants.createGrant(TEST_USER, "unscoped-write", "", false, PROFILE).apiKey;

    const { Hono } = require("hono");
    app = new Hono();
    app.use("*", createAuthMiddleware({ mode: "multi-user" }));
    app.use("/mcp/*", createMcpAuthMiddleware());

    // Mirrors index.js's readonlyRefused() gate and route wiring exactly —
    // same mcp-items.js calls, same "scope/readonly/profile/user come only
    // from the grant context" rule.
    function readonlyRefused(c) {
      return c.get("readonly") ? c.json({ error: "This grant is read-only; mutating routes are refused." }, 403) : null;
    }

    app.get("/mcp/tags", (c) => {
      const tags = mcpItemsMod.listTags(c.get("userId"), c.get("profileId"), c.get("scopeTag"), {
        search: c.req.query("search") || undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      });
      return c.json({ tags });
    });

    app.post("/mcp/items", async (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const body = await c.req.json().catch(() => ({}));
      const result = mcpItemsMod.createItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), body);
      if (result.status === "invalid") return c.json({ error: result.error }, 400);
      return c.json({ item: result.item });
    });

    app.patch("/mcp/items/:id", async (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const body = await c.req.json().catch(() => ({}));
      const result = mcpItemsMod.updateItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body);
      if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
      return c.json({ item: result.item });
    });

    app.delete("/mcp/items/:id", (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const result = mcpItemsMod.deleteItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"));
      if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
      return c.json(result.result);
    });

    app.post("/mcp/items/:id/tags", async (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const body = await c.req.json().catch(() => ({}));
      const result = mcpItemsMod.tagItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body.name);
      if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
      if (result.status === "invalid") return c.json({ error: result.error }, 400);
      return c.json(result.result);
    });

    app.delete("/mcp/items/:id/tags/:name", (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const result = mcpItemsMod.untagItem(
        c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), c.req.param("name")
      );
      if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
      if (result.status === "orphan") return c.json({ error: result.error }, 400);
      return c.json(result.result);
    });

    app.post("/mcp/items/:id/events", async (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const body = await c.req.json().catch(() => ({}));
      const result = mcpItemsMod.recordEvent(
        c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body.type, body.value
      );
      if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
      if (result.status === "invalid") return c.json({ error: result.error }, 400);
      return c.json(result.result);
    });

    app.post("/mcp/tasks/:id/complete", async (c) => {
      const refused = readonlyRefused(c);
      if (refused) return refused;
      const body = await c.req.json().catch(() => ({}));
      const result = mcpItemsMod.completeTask(
        c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body.notes
      );
      if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
      return c.json({ item: result.item });
    });
  });

  after(() => {
    if (db && db.closeAllConnections) db.closeAllConnections();
    if (users && users.closeSystemDb) users.closeSystemDb();
    cleanTestDir();
  });

  function scopedHeaders() {
    return { Authorization: `Bearer ${SCOPED_KEY}`, "Content-Type": "application/json" };
  }
  function readonlyHeaders() {
    return { Authorization: `Bearer ${READONLY_KEY}`, "Content-Type": "application/json" };
  }
  function unscopedHeaders() {
    return { Authorization: `Bearer ${UNSCOPED_KEY}`, "Content-Type": "application/json" };
  }

  function makeItem(tags, title = "Item") {
    return db.saveItem(TEST_USER, "text", "body", tags, null, null, PROFILE, null, "", title);
  }

  describe("smoke: each of the eight endpoints does its documented job", () => {
    it("GET /mcp/tags lists tags with item counts", async () => {
      makeItem(["work", "todo"], "A");
      const res = await app.request("/mcp/tags", { headers: scopedHeaders() });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      const workTag = json.tags.find((t) => t.name === "work");
      assert.ok(workTag, "scope-owned tag should be listed");
      assert.strictEqual(workTag.itemCount, 1);
    });

    it("PATCH /mcp/items/:id updates title/content/metadata and stamps updatedAt", async () => {
      const id = makeItem(["work"], "Before");
      const res = await app.request(`/mcp/items/${id}`, {
        method: "PATCH",
        headers: scopedHeaders(),
        body: JSON.stringify({ title: "After" }),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.item.title, "After");
    });

    it("DELETE /mcp/items/:id soft-deletes", async () => {
      const id = makeItem(["work"]);
      const res = await app.request(`/mcp/items/${id}`, { method: "DELETE", headers: scopedHeaders() });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.id, id);
    });

    it("POST /mcp/items/:id/events records an event", async () => {
      const id = makeItem(["work"]);
      const res = await app.request(`/mcp/items/${id}/events`, {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "started", value: "kicked off" }),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.type, "started");
    });

    it("returns 404 for a write against an out-of-scope item, same as a nonexistent one", async () => {
      const outOfScopeId = makeItem(["personal"]);
      const res = await app.request(`/mcp/items/${outOfScopeId}`, {
        method: "PATCH",
        headers: scopedHeaders(),
        body: JSON.stringify({ title: "nope" }),
      });
      assert.strictEqual(res.status, 404);
    });
  });

  describe("the readonly gate (design doc §4.1)", () => {
    it("refuses every mutating route with 403 for a readonly grant", async () => {
      const id = makeItem(["work", "todo"]);
      const calls = [
        ["POST", "/mcp/items", { type: "text", content: "x" }],
        ["PATCH", `/mcp/items/${id}`, { title: "nope" }],
        ["POST", `/mcp/items/${id}/tags`, { name: "extra" }],
        ["DELETE", `/mcp/items/${id}/tags/todo`, null],
        ["POST", `/mcp/items/${id}/events`, { type: "note" }],
        ["POST", `/mcp/tasks/${id}/complete`, { notes: "x" }],
        ["DELETE", `/mcp/items/${id}`, null],
      ];
      for (const [method, path, body] of calls) {
        const res = await app.request(path, {
          method,
          headers: readonlyHeaders(),
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.strictEqual(res.status, 403, `${method} ${path} should be refused for a readonly grant`);
      }
    });

    it("the readonly bit comes from the grant, not anything the client sends", async () => {
      // The readonly grant's own key is used, but the body claims otherwise —
      // the gate must still refuse, because it reads c.get('readonly') only.
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: readonlyHeaders(),
        body: JSON.stringify({ type: "text", content: "x", readonly: false }),
      });
      assert.strictEqual(res.status, 403);
    });

    it("the same routes succeed for a non-readonly grant", async () => {
      const id = makeItem(["work"]);
      const res = await app.request(`/mcp/items/${id}`, {
        method: "PATCH",
        headers: scopedHeaders(),
        body: JSON.stringify({ title: "allowed" }),
      });
      assert.strictEqual(res.status, 200);
    });
  });

  describe("writes force-add the scope tag (design doc §4.1)", () => {
    it("an item created through a scoped grant always carries the scope tag, even when not listed", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body", tags: ["misc"] }),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.deepStrictEqual(json.item.tags.sort(), ["misc", "work"]);
    });

    it("an item created with no tags at all still carries the scope tag", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body" }),
      });
      const json = await res.json();
      assert.deepStrictEqual(json.item.tags, ["work"]);
    });

    it("an unscoped grant force-adds nothing", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: unscopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body", tags: ["misc"] }),
      });
      const json = await res.json();
      assert.deepStrictEqual(json.item.tags, ["misc"]);
    });
  });

  describe("a tag naming a foreign namespace is rejected with 400 (design doc §4.1)", () => {
    it("create_item rejects a foreign-namespaced tag", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body", tags: ["personal:secret"] }),
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /outside scope/);
    });

    it("create_item allows a bare (colon-free) tag — shared vocabulary is never foreign", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body", tags: ["todo"] }),
      });
      assert.strictEqual(res.status, 200);
    });

    it("create_item allows a tag namespaced under the grant's own scope", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body", tags: ["work:sub"] }),
      });
      assert.strictEqual(res.status, 200);
    });

    it("tag_item rejects a foreign-namespaced tag on an existing item", async () => {
      const id = makeItem(["work"]);
      const res = await app.request(`/mcp/items/${id}/tags`, {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ name: "personal:secret" }),
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /outside scope/);
    });

    it("an unscoped grant is never subject to the foreign-namespace rule", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: unscopedHeaders(),
        body: JSON.stringify({ type: "text", content: "body", tags: ["personal:secret"] }),
      });
      assert.strictEqual(res.status, 200);
    });
  });

  describe("create_item refuses type 'image' (design doc §9)", () => {
    it("returns a clear 400, not a silent create", async () => {
      const res = await app.request("/mcp/items", {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ type: "image", content: "base64" }),
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /image/);
    });
  });

  describe("untag refuses to orphan (design doc §4.1)", () => {
    it("refuses to remove the only tag keeping the item in scope", async () => {
      const id = makeItem(["work"]);
      const res = await app.request(`/mcp/items/${id}/tags/work`, {
        method: "DELETE",
        headers: scopedHeaders(),
      });
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /only tag keeping this item in scope/);

      // The item must still carry its scope tag — the refusal must be real,
      // not just an HTTP status with the mutation applied anyway.
      const tags = mcpItemsMod.queryItems(TEST_USER, PROFILE, "work", { limit: 50 })
        .find((i) => i.id === id).tags;
      assert.deepStrictEqual(tags, ["work"]);
    });

    it("refuses when the remaining tags are all out of scope", async () => {
      const id = makeItem(["work", "todo"]);
      const res = await app.request(`/mcp/items/${id}/tags/work`, {
        method: "DELETE",
        headers: scopedHeaders(),
      });
      assert.strictEqual(res.status, 400);
    });

    it("allows removal when another in-scope tag survives", async () => {
      const id = makeItem(["work", "work:sub"]);
      const res = await app.request(`/mcp/items/${id}/tags/work`, {
        method: "DELETE",
        headers: scopedHeaders(),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
    });

    it("removing a bare, non-scope-owned tag is never subject to the orphan check", async () => {
      const id = makeItem(["work", "todo"]);
      const res = await app.request(`/mcp/items/${id}/tags/todo`, {
        method: "DELETE",
        headers: scopedHeaders(),
      });
      assert.strictEqual(res.status, 200);
    });

    it("an unscoped grant is never subject to the orphan check", async () => {
      const id = db.saveItem(TEST_USER, "text", "body", ["solo"], null, null, PROFILE, null, "", "Item");
      const res = await app.request(`/mcp/items/${id}/tags/solo`, {
        method: "DELETE",
        headers: unscopedHeaders(),
      });
      assert.strictEqual(res.status, 200);
    });
  });

  describe("untag decodes a namespaced tag name in the path segment (the primary path — every status tag is namespaced, e.g. peek:todo)", () => {
    function tagsOf(id) {
      const conn = db.getConnection(TEST_USER, PROFILE);
      return conn
        .all("SELECT t.name FROM tags t JOIN item_tags it ON t.id = it.tagId WHERE it.itemId = ?", [id])
        .map((r) => r.name)
        .sort();
    }

    it("removes a namespaced tag via a raw (unencoded) colon in the path segment", async () => {
      // Another in-scope tag ("work") survives the removal, so this is
      // exercising decoding, not the orphan refusal above.
      const id = makeItem(["work", "work:todo"]);
      const res = await app.request(`/mcp/items/${id}/tags/work:todo`, {
        method: "DELETE",
        headers: scopedHeaders(),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.tagName, "work:todo");
      assert.deepStrictEqual(tagsOf(id), ["work"]);
    });

    it("removes a namespaced tag via a percent-encoded colon (%3A) in the path segment", async () => {
      const id = makeItem(["work", "work:todo"]);
      const res = await app.request(`/mcp/items/${id}/tags/work%3Atodo`, {
        method: "DELETE",
        headers: scopedHeaders(),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.tagName, "work:todo");
      assert.deepStrictEqual(tagsOf(id), ["work"]);
    });
  });

  describe("POST /mcp/tasks/:id/complete is one transaction (design doc §3.3/§4.1)", () => {
    it("on success: adds done, removes todo, and records one completion event", async () => {
      const id = makeItem(["work", "todo"]);
      const res = await app.request(`/mcp/tasks/${id}/complete`, {
        method: "POST",
        headers: scopedHeaders(),
        body: JSON.stringify({ notes: "shipped it" }),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.deepStrictEqual(json.item.tags.sort(), ["done", "work"]);

      const conn = db.getConnection(TEST_USER, PROFILE);
      const events = conn.all("SELECT content FROM item_events WHERE itemId = ?", [id]);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].content, "completed");
    });

    it("a failure recording the event leaves the tag state exactly as it was — no partial completion", () => {
      const id = makeItem(["work", "todo"]);
      const conn = db.getConnection(TEST_USER, PROFILE);
      const originalRun = conn.run.bind(conn);
      conn.run = (sql, params) => {
        if (sql.includes("INSERT INTO item_events")) {
          throw new Error("simulated failure recording the completion event");
        }
        return originalRun(sql, params);
      };

      assert.throws(() => mcpItemsMod.completeTask(TEST_USER, PROFILE, "work", id, "notes"));
      conn.run = originalRun;

      const tagsAfter = conn
        .all("SELECT t.name FROM tags t JOIN item_tags it ON t.id = it.tagId WHERE it.itemId = ?", [id])
        .map((r) => r.name)
        .sort();
      assert.deepStrictEqual(tagsAfter, ["todo", "work"], "done must not apply and todo must survive a rolled-back transaction");

      const events = conn.all("SELECT * FROM item_events WHERE itemId = ?", [id]);
      assert.strictEqual(events.length, 0, "no completion event should exist when the transaction rolled back");
    });
  });
});
