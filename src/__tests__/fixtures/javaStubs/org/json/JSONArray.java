package org.json;

import java.util.ArrayList;
import java.util.List;

/** Test fake: the part of org.json.JSONArray the shell's widget code uses, same defaults. */
public class JSONArray {
    private final List<Object> list;

    public JSONArray() {
        this.list = new ArrayList<>();
    }

    JSONArray(List<Object> list) {
        this.list = list;
    }

    public JSONArray(String json) throws JSONException {
        Object v = new JSONTokener(json).readWhole();
        if (!(v instanceof JSONArray)) throw new JSONException("not a JSON array");
        this.list = ((JSONArray) v).list;
    }

    public int length() { return list.size(); }

    public Object opt(int i) { return i >= 0 && i < list.size() ? list.get(i) : null; }

    public JSONObject optJSONObject(int i) {
        Object v = opt(i);
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    public String optString(int i) {
        Object v = opt(i);
        return v == null || v == JSONObject.NULL ? "" : String.valueOf(v);
    }

    public JSONArray put(Object v) {
        list.add(v);
        return this;
    }

    public JSONArray put(long v) { return put((Object) v); }
    public JSONArray put(int v) { return put((Object) (long) v); }

    @Override
    public String toString() {
        StringBuilder b = new StringBuilder("[");
        for (Object v : list) {
            if (b.length() > 1) b.append(',');
            b.append(JSONTokener.write(v));
        }
        return b.append(']').toString();
    }
}
