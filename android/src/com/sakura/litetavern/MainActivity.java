package com.sakura.litetavern;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/** Full-screen WebView shell for Sakura (no address bar). */
public class MainActivity extends Activity {
    private static final int FILE_REQ = 1;
    // filled in at build time from sakura.config.json (apkDefaultUrl / apkAltUrl); empty = ask on first launch
    private static final String LAN = Defaults.URL;
    private static final String EASYTIER = Defaults.ALT_URL;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private SharedPreferences sp;
    private boolean dialogShown = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("lt", MODE_PRIVATE);
        getWindow().setStatusBarColor(Color.parseColor("#f8f6f2"));
        getWindow().setNavigationBarColor(Color.parseColor("#f8f6f2"));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f8f6f2"));
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String host = Uri.parse(url()).getHost();
                if (u.getHost() != null && u.getHost().equals(host)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no browser */ }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showAddress(String.valueOf(e.getDescription()));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    Intent i = p.createIntent();
                    i.setType("*/*");
                    if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(i, FILE_REQ);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });
        if (b != null) web.restoreState(b);
        else if (url().isEmpty()) showAddress("第一次使用：填写电脑上 Sakura 的地址（例如 http://192.168.x.x:8291/）");
        else web.loadUrl(url());
    }

    private String url() {
        return sp.getString("url", LAN);
    }

    private void go(String u) {
        if (u.isEmpty()) { showAddress("地址不能为空"); return; }
        if (!u.endsWith("/")) u = u + "/";
        if (!u.startsWith("http")) u = "http://" + u;
        sp.edit().putString("url", u).apply();
        dialogShown = false;
        web.loadUrl(u);
    }

    private void showAddress(String msg) {
        if (dialogShown || isFinishing()) return;
        dialogShown = true;
        final EditText et = new EditText(this);
        et.setText(url());
        AlertDialog.Builder dlg = new AlertDialog.Builder(this)
            .setTitle("连不上 Sakura")
            .setMessage(msg + "\n\n确认电脑上的 Sakura 开着。地址可以改：")
            .setView(et)
            .setCancelable(false)
            .setPositiveButton("重试", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { go(et.getText().toString().trim()); }
            })
            .setNegativeButton("关闭", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { dialogShown = false; }
            });
        if (!EASYTIER.isEmpty()) {
            dlg.setNeutralButton("备用地址", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { go(url().equals(EASYTIER) ? LAN : EASYTIER); }
            });
        }
        dlg.show();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == FILE_REQ && fileCb != null) {
            Uri[] result = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[] { data.getData() };
                }
            }
            fileCb.onReceiveValue(result);
            fileCb = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
