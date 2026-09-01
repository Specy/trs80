// Pathname helpers shared by the assembler wrapper and the source map. This
// module is deliberately not re-exported from index.ts: the two must agree on
// exactly how a pathname is spelled, but that agreement is an implementation
// detail and not part of the package's public API.

/**
 * Clean up a pathname so that the various spellings of the same file end up
 * being the same string. The assembler resolves included files against the
 * directory of the including file, so "other.asm" included from "main.asm"
 * becomes "./other.asm"; we want that to find the caller's "other.asm" entry
 * and to be reported as "other.asm" in diagnostics and source locations.
 *
 * Removes empty and "." components, and applies ".." components when there's
 * something to remove. Never converts a relative path to an absolute one.
 */
export function normalizePathname(pathname: string): string {
    const isAbsolute = pathname.startsWith("/");

    const parts: string[] = [];
    for (const part of pathname.split("/")) {
        if (part === "" || part === ".") {
            // Nothing to do, these don't affect the path.
        } else if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
            parts.pop();
        } else {
            parts.push(part);
        }
    }

    return (isAbsolute ? "/" : "") + parts.join("/");
}

/**
 * The directory part of a normalized pathname, or "" for a file at the top
 * level. Never has a trailing slash.
 */
export function directoryOfPathname(pathname: string): string {
    const i = pathname.lastIndexOf("/");
    return i < 0 ? "" : pathname.substring(0, i);
}
