-- 以前新建 Chrome 没填出口地时存的是占位文字「第一次打开时检测」，系统其实从不检测。清成空，界面显示「没填」。
UPDATE "browser_profiles" SET "exit_ip" = '' WHERE "exit_ip" = '第一次打开时检测';
