package hr.strukovnasamobor.rontomap;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import android.util.Base64;

import android.content.Context;
import androidx.core.content.FileProvider;

@CapacitorPlugin(name = "Download")
public class DownloadPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String fileName = call.getString("fileName");
        String base64Data = call.getString("data");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        if (fileName == null || base64Data == null) {
            call.reject("Missing fileName or data");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            Context context = getContext();
            Uri savedUri = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+: use MediaStore
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                savedUri = context.getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);

                if (savedUri == null) {
                    call.reject("Failed to create file in Downloads");
                    return;
                }

                OutputStream os = context.getContentResolver().openOutputStream(savedUri);
                if (os != null) {
                    os.write(bytes);
                    os.close();
                }
            } else {
                // Android 9 and below: write directly to Downloads
                File downloadsDir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                File file = new File(downloadsDir, fileName);
                FileOutputStream fos = new FileOutputStream(file);
                fos.write(bytes);
                fos.close();
                savedUri = FileProvider.getUriForFile(context,
                        context.getPackageName() + ".fileprovider", file);
            }

            // Open share sheet
            if (savedUri != null) {
                try {
                    Intent shareIntent = new Intent(Intent.ACTION_SEND);
                    shareIntent.setType(mimeType);
                    shareIntent.putExtra(Intent.EXTRA_STREAM, savedUri);
                    shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                    Intent chooser = Intent.createChooser(shareIntent, null);
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                    if (getActivity() != null) {
                        getActivity().startActivity(chooser);
                    } else {
                        context.startActivity(chooser);
                    }
                } catch (Exception shareEx) {
                    // File saved successfully — share sheet failed. Surface the
                    // error to JS so the caller can toast the user instead of
                    // silently claiming success.
                    call.reject("Share failed: " + shareEx.getMessage());
                    return;
                }
            }

            call.resolve();
        } catch (Exception e) {
            call.reject("Download failed: " + e.getMessage());
        }
    }
}
