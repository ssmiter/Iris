package com.iris.storage;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Iris 私有的不可变内容仓。
 *
 * <p>调用方只持有 object ref；物理路径、分片方式与原子写入由本类独占。
 * 对象先落盘，领域事实再提交引用，因此失败只会留下可回收孤儿对象。</p>
 */
@Service
public class ManagedObjectStore {

    private static final String REF_PREFIX = "object://sha256/";
    private static final Pattern REF_PATTERN = Pattern.compile(
            "^object://sha256/([a-f0-9]{64})$"
    );
    private static final int COPY_BUFFER_BYTES = 16 * 1024;

    private final Path root;

    public ManagedObjectStore(
            @Value(
                    "${iris.storage.object-root:"
                            + "${user.home}/Iris/data/objects}"
            ) String configuredRoot
    ) throws IOException {
        String expanded = expandHome(configuredRoot);
        Path candidate = Path.of(expanded).toAbsolutePath().normalize();
        Files.createDirectories(candidate);
        this.root = candidate.toRealPath();
    }

    public StoredObject putUtf8(String content) throws IOException {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        return put(bytes);
    }

    public StoredObject put(byte[] content) throws IOException {
        String digest = digest(content);
        Path target = objectPath(digest, true);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            verifyExisting(target, digest, content.length);
            return stored(digest, content.length);
        }

        Path temporary = Files.createTempFile(
                target.getParent(),
                "." + digest.substring(0, 12) + "-",
                ".tmp"
        );
        try {
            try (FileChannel channel = FileChannel.open(
                    temporary,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.TRUNCATE_EXISTING
            )) {
                ByteBuffer buffer = ByteBuffer.wrap(content);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            try {
                Files.move(
                        temporary,
                        target,
                        StandardCopyOption.ATOMIC_MOVE
                );
            } catch (FileAlreadyExistsException exception) {
                verifyExisting(target, digest, content.length);
            } catch (AtomicMoveNotSupportedException exception) {
                throw new IOException(
                        "Managed Object Store requires atomic moves",
                        exception
                );
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
        return stored(digest, content.length);
    }

    public byte[] readBytes(String objectRef, long maximumBytes)
            throws IOException {
        if (maximumBytes < 0) {
            throw new IllegalArgumentException(
                    "maximumBytes must not be negative"
            );
        }
        String digest = digestFromRef(objectRef);
        Path object = objectPath(digest, false);
        long size = Files.size(object);
        if (size > maximumBytes) {
            throw new IOException(
                    "Managed object exceeds the permitted read size"
            );
        }
        byte[] content = Files.readAllBytes(object);
        requireDigest(digest, digest(content));
        return content;
    }

    /**
     * UTF-8 字符窗口。字符位置与 Java String.length() 一致（UTF-16 code unit）。
     * 深分页首版为 O(offset)，但读取内存恒定且不会水合完整对象。
     */
    public String readUtf8Window(
            String objectRef,
            int startCharacter,
            int characterCount
    ) throws IOException {
        if (startCharacter < 0 || characterCount < 1) {
            throw new IllegalArgumentException(
                    "Invalid UTF-8 object window"
            );
        }
        String digest = digestFromRef(objectRef);
        Path object = objectPath(digest, false);
        var decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try (Reader reader = new InputStreamReader(
                Files.newInputStream(object),
                decoder
        )) {
            skipCharacters(reader, startCharacter);
            char[] buffer = new char[Math.min(
                    COPY_BUFFER_BYTES,
                    characterCount
            )];
            StringBuilder window = new StringBuilder(characterCount);
            while (window.length() < characterCount) {
                int requested = Math.min(
                        buffer.length,
                        characterCount - window.length()
                );
                int read = reader.read(buffer, 0, requested);
                if (read < 0) {
                    break;
                }
                window.append(buffer, 0, read);
            }
            return window.toString();
        }
    }

    /**
     * Workspace 与对象仓必须完全分离，避免普通文件 Tool 枚举内部内容。
     */
    public void requireSeparatedFrom(Path otherRoot) {
        Path normalized = otherRoot.toAbsolutePath().normalize();
        if (root.startsWith(normalized) || normalized.startsWith(root)) {
            throw new IllegalStateException(
                    "Managed Object Store and User Workspace must not overlap"
            );
        }
    }

    private void skipCharacters(Reader reader, int count)
            throws IOException {
        int remaining = count;
        while (remaining > 0) {
            long skipped = reader.skip(remaining);
            if (skipped > 0) {
                remaining -= Math.toIntExact(skipped);
                continue;
            }
            if (reader.read() < 0) {
                return;
            }
            remaining--;
        }
    }

    private Path objectPath(String digest, boolean createParent)
            throws IOException {
        Path parent = root.resolve("sha256")
                .resolve(digest.substring(0, 2))
                .resolve(digest.substring(2, 4));
        if (createParent) {
            Files.createDirectories(parent);
        }
        Path realParent = parent.toRealPath();
        if (!realParent.startsWith(root)) {
            throw new IOException(
                    "Managed object path escaped its configured root"
            );
        }
        Path target = realParent.resolve(digest + ".object");
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)
                && (!Files.isRegularFile(
                        target,
                        LinkOption.NOFOLLOW_LINKS
                ) || Files.isSymbolicLink(target))) {
            throw new IOException(
                    "Managed object target is not a regular file"
            );
        }
        return target;
    }

    private void verifyExisting(
            Path target,
            String expectedDigest,
            long expectedBytes
    ) throws IOException {
        if (Files.size(target) != expectedBytes) {
            throw new IOException(
                    "Managed object hash collision or corrupted object"
            );
        }
        MessageDigest digest = sha256();
        try (DigestInputStream input = new DigestInputStream(
                Files.newInputStream(target),
                digest
        )) {
            input.transferTo(java.io.OutputStream.nullOutputStream());
        }
        requireDigest(
                expectedDigest,
                HexFormat.of().formatHex(digest.digest())
        );
    }

    private String digestFromRef(String objectRef) {
        Matcher matcher = REF_PATTERN.matcher(
                objectRef == null ? "" : objectRef
        );
        if (!matcher.matches()) {
            throw new IllegalArgumentException(
                    "Invalid managed object reference"
            );
        }
        return matcher.group(1);
    }

    private StoredObject stored(String digest, long byteCount) {
        return new StoredObject(REF_PREFIX + digest, digest, byteCount);
    }

    private String digest(byte[] content) {
        return HexFormat.of().formatHex(sha256().digest(content));
    }

    private void requireDigest(String expected, String actual)
            throws IOException {
        if (!expected.equals(actual)) {
            throw new IOException("Managed object integrity check failed");
        }
    }

    private MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private String expandHome(String configured) {
        return configured.startsWith("~/")
                || configured.startsWith("~\\")
                ? System.getProperty("user.home") + configured.substring(1)
                : configured;
    }

    public record StoredObject(
            String objectRef,
            String contentHash,
            long byteCount
    ) {
    }
}
