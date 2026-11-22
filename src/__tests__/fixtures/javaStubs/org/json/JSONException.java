package org.json;

/** Test fake of org.json.JSONException (checked, as on Android). */
public class JSONException extends Exception {
    public JSONException(String message) {
        super(message);
    }
}
