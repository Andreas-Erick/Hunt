package org.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Test fake: a strict JSON reader for the minimal org.json fakes (objects, arrays, strings,
 * numbers, true, false, null). Anything else throws JSONException, as org.json does.
 */
public class JSONTokener {
    private final String s;
    private int i;

    public JSONTokener(String s) {
        this.s = s == null ? "" : s;
    }

    /** Reads exactly one value and nothing after it but whitespace. */
    Object readWhole() throws JSONException {
        Object v = value();
        skipWs();
        if (i != s.length()) throw new JSONException("trailing text at " + i);
        return v;
    }

    private void skipWs() {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    private Object value() throws JSONException {
        skipWs();
        if (i >= s.length()) throw new JSONException("end of input");
        char c = s.charAt(i);
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') return string();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return JSONObject.NULL; }
        return number();
    }

    private JSONObject object() throws JSONException {
        Map<String, Object> m = new LinkedHashMap<>();
        i++;
        skipWs();
        if (i < s.length() && s.charAt(i) == '}') { i++; return new JSONObject(m); }
        while (true) {
            skipWs();
            if (i >= s.length() || s.charAt(i) != '"') throw new JSONException("expected a key at " + i);
            String k = string();
            skipWs();
            expect(':');
            m.put(k, value());
            skipWs();
            if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
            expect('}');
            return new JSONObject(m);
        }
    }

    private JSONArray array() throws JSONException {
        List<Object> l = new ArrayList<>();
        i++;
        skipWs();
        if (i < s.length() && s.charAt(i) == ']') { i++; return new JSONArray(l); }
        while (true) {
            l.add(value());
            skipWs();
            if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
            expect(']');
            return new JSONArray(l);
        }
    }

    private String string() throws JSONException {
        StringBuilder b = new StringBuilder();
        i++;
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            if (i >= s.length()) break;
            char e = s.charAt(i++);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                case 'r': b.append('\r'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u':
                    if (i + 4 > s.length()) throw new JSONException("bad escape");
                    b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    i += 4;
                    break;
                default: b.append(e);
            }
        }
        throw new JSONException("unterminated string");
    }

    private Object number() throws JSONException {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String n = s.substring(start, i);
        if (n.isEmpty()) throw new JSONException("unexpected character at " + start);
        try {
            if (n.matches("-?\\d+")) return Long.parseLong(n);
            return Double.parseDouble(n);
        } catch (NumberFormatException e) {
            throw new JSONException("bad number " + n);
        }
    }

    private void expect(char c) throws JSONException {
        if (i >= s.length() || s.charAt(i) != c) throw new JSONException("expected '" + c + "' at " + i);
        i++;
    }

    static String quote(String v) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : v.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    static String write(Object v) {
        if (v instanceof String) return quote((String) v);
        return String.valueOf(v);
    }
}
