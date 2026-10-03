package com.quantmonitor.paper;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.util.Log;

import java.lang.ref.WeakReference;

/**
 * DebugFinishReceiver · 仅用于自动化验证(BACKGROUND READY 证据)
 *
 * 作用:从 adb 触发"真正销毁 Activity"(finishAndRemoveTask),用来证明
 *       Activity 不存在时 Paper Runtime 仍在服务里继续 tick。
 * 安全:非可调试(即 release)构建直接忽略,不产生任何行为。
 */
public class DebugFinishReceiver extends BroadcastReceiver {
    private static final String TAG = "PaperRuntime";
    private static WeakReference<Activity> current = new WeakReference<Activity>(null);

    public static void attach(Activity activity) {
        current = new WeakReference<Activity>(activity);
    }

    private static boolean debuggable(Context ctx) {
        try {
            return (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!debuggable(context)) {
            Log.i(TAG, "debug finish ignored (release build)");
            return;
        }
        Activity activity = current.get();
        if (activity == null) {
            Log.i(TAG, "debug finish: no activity attached");
            return;
        }
        Log.i(TAG, "debug finish: destroying activity, service keeps running=" + PaperForegroundService.isRuntimeRunning());
        activity.finishAndRemoveTask();
    }
}
