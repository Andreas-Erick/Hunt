package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** Test fake: the part of org.json.JSONObject the shell's widget code uses, same defaults. */
public class JSONObject {
    public static final Object NULL = new Object() {
        @Override
        public String toString() {
            return "null";
        }
    };
    private final Map<String, Object> map;

    public JSONObject() {
        this.map = new LinkedHashMap<>();
    }

    JSONObject(Map<String, Object> map) {
        this.map = map;
    }

    public JSONObject(String json) throws JSONException {
        Object v = new JSONTokener(json).readWhole();
        if (!(v instanceof JSONObject)) throw new JSONException("not a JSON object");
        this.map = ((JSONObject) v).map;
    }

    public JSONObject put(String k, Object v) throws JSONException {
        if (k == null) throw new JSONException("null key");
        if (v == null) map.remove(k);
        else map.put(k, v);
        return this;
    }

    public JSONObject put(String k, long v) throws JSONException { return put(k, (Object) v); }
    public JSONObject put(String k, int v) throws JSONException { return put(k, (Object) (long) v); }
    public JSONObject put(String k, boolean v) throws JSONException { return put(k, (Object) v); }
    public JSONObject put(String k, double v) throws JSONException { return put(k, (Object) v); }

    public boolean has(String k) { return map.containsKey(k); }
    public Object opt(String k) { return map.get(k); }
    public Iterator<String> keys() { return map.keySet().iterator(); }

    public String optString(String k) { return optString(k, ""); }

    public String optString(String k, String fallback) {
        Object v = map.get(k);
        return v == null || v == NULL ? fallback : String.valueOf(v);
    }

    public long optLong(String k) { return optLong(k, 0L); }

    public long optLong(String k, long fallback) {
        Object v = map.get(k);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try {
                return (long) Double.parseDouble((String) v);
            } catch (NumberFormatException e) {
                return fallback;
            }
        }
        return fallback;
    }

    public int optInt(String k) { return (int) optLong(k, 0L); }
    public int optInt(String k, int fallback) { return (int) optLong(k, fallback); }

    public double optDouble(String k, double fallback) {
        Object v = map.get(k);
        return v instanceof Number ? ((Number) v).doubleValue() : fallback;
    }

    public boolean optBoolean(String k) { return optBoolean(k, false); }

    public boolean optBoolean(String k, boolean fallback) {
        Object v = map.get(k);
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return Boolean.parseBoolean((String) v);
        return fallback;
    }

    public JSONArray optJSONArray(String k) {
        Object v = map.get(k);
        return v instanceof JSONArray ? (JSONArray) v : null;
    }

    public JSONObject optJSONObject(String k) {
        Object v = map.get(k);
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    @Override
    public String toString() {
        StringBuilder b = new StringBuilder("{");
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (b.length() > 1) b.append(',');
            b.append(JSONTokener.quote(e.getKey())).append(':').append(JSONTokener.write(e.getValue()));
        }
        return b.append('}').toString();
    }
}
