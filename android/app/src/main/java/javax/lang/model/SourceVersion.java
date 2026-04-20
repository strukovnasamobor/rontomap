package javax.lang.model;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Minimal stub of the JDK's {@code javax.lang.model.SourceVersion}.
 *
 * Android does not ship the {@code javax.lang.model} package (it's part of the
 * Java compiler API). GraphHopper 8.0 calls {@link #isName(CharSequence)} from
 * {@code IntEncodedValueImpl.isValidEncodedValue} to sanity-check encoded value
 * names, which crashes the import with {@code NoClassDefFoundError}.
 *
 * Only the surface GraphHopper actually touches is implemented. If something
 * else in the dep tree starts reaching for {@code RELEASE_X} or other members,
 * extend this stub rather than pulling in a fake JDK jar.
 */
public final class SourceVersion {

    private static final Set<String> KEYWORDS;
    static {
        Set<String> s = new HashSet<>();
        // JLS reserved words + literals that cannot be identifiers.
        Collections.addAll(s,
            "abstract", "assert", "boolean", "break", "byte", "case", "catch",
            "char", "class", "const", "continue", "default", "do", "double",
            "else", "enum", "extends", "final", "finally", "float", "for",
            "goto", "if", "implements", "import", "instanceof", "int",
            "interface", "long", "native", "new", "package", "private",
            "protected", "public", "return", "short", "static", "strictfp",
            "super", "switch", "synchronized", "this", "throw", "throws",
            "transient", "try", "void", "volatile", "while",
            "true", "false", "null", "_");
        KEYWORDS = Collections.unmodifiableSet(s);
    }

    private SourceVersion() {}

    /**
     * True if {@code name} is a syntactically valid Java name —
     * one or more dot-separated identifiers, none of which is a reserved word.
     */
    public static boolean isName(CharSequence name) {
        if (name == null) return false;
        String s = name.toString();
        if (s.isEmpty()) return false;
        int start = 0;
        for (int i = 0; i <= s.length(); i++) {
            if (i == s.length() || s.charAt(i) == '.') {
                if (!isIdentifier(s.substring(start, i))) return false;
                start = i + 1;
            }
        }
        return true;
    }

    /** Same as {@link #isName(CharSequence)} — the version arg is ignored. */
    public static boolean isName(CharSequence name, Object version) {
        return isName(name);
    }

    public static boolean isIdentifier(CharSequence name) {
        if (name == null) return false;
        String s = name.toString();
        if (s.isEmpty()) return false;
        if (KEYWORDS.contains(s)) return false;
        if (!Character.isJavaIdentifierStart(s.charAt(0))) return false;
        for (int i = 1; i < s.length(); i++) {
            if (!Character.isJavaIdentifierPart(s.charAt(i))) return false;
        }
        return true;
    }

    public static boolean isKeyword(CharSequence s) {
        return s != null && KEYWORDS.contains(s.toString());
    }
}
