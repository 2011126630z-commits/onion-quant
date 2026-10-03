package com.quantmonitor.paper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/**
 * BootReceiver · V15(§90)
 * 设备重启后:若用户之前开启了"自动启动",则恢复 Paper Engine 的前台服务与状态。
 * 注意:不自动交易 —— 引擎是否继续运行由用户在 App 内的开关决定(此处仅恢复服务与状态标记)。
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";
    private static final String PREFS = "paper_prefs";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action)
            || "android.intent.action.QUICKBOOT_POWERON".equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!boot) return;
        SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean autoStart = sp.getBoolean("auto_start", false);
        Log.i(TAG, "boot received, auto_start=" + autoStart);
        if (!autoStart) return;
        try {
            PaperForegroundService.ensureChannels(context);
            Intent svc = new Intent(context, PaperForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc);
            else context.startService(svc);
        } catch (Exception e) {
            Log.w(TAG, "restore service failed: " + e.getMessage());
        }
    }
}
