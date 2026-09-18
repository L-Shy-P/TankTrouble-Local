# -*- coding: utf-8 -*-
"""
提取游戏核心文件
从缓存的HTML中提取游戏运行所需的核心JS文件
"""

import os
import re
import hashlib
from pathlib import Path

# 缓存目录
CACHE_DIR = "../cache"
GAME_CORE_DIR = "."

# 游戏核心JS文件列表（从HTML中提取）
CORE_JS_FILES = [
    # jQuery核心
    "code.jquery.com/jquery-1.11.2.min.js",
    "code.jquery.com/ui/1.11.4/jquery-ui.min.js",
    
    # 游戏引擎和库
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/jkstra/jkstra.js.pagespeed.jm.9h2fWl4SGo.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/phaser/phaser.min.js.pagespeed.jm.Qef6sZwzE4.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/phaserplugins/phaser-spine.js.pagespeed.jm.beLLMvqXLv.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/phaserplugins/phaser-nineslice.min.js.pagespeed.jm.N1BB1DcYiw.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/box2d/Box2dWeb-2.1.0-b.min.js.pagespeed.ce.e7B5xOr4jI.js",
    
    # 编码和序列化
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/encoding,_textencoderlite.js+schemapack,_schemapack.min.js+adproviders,_adplacementadprovider.js+howler,_howler.core.min.js+main.js+caches.js+users.js+inputs.js.pagespeed.jc.JTTGjiZLXj.js",
    
    # 工具类
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/utils.js+adminutils.js+achievementmanager.js+advertisementmanager.js+analyticsmanager.js+audiomanager.js+clientmanager.js+clipboardmanager.js+deletedemailsmanager.js+focusmanager.js.pagespeed.jc.tmsmWL21hw.js",
    
    # 游戏管理器
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/gamemanager.js+iframemanager.js+inputmanager.js+keyboardinputmanager.js+mouseinputmanager.js+overlaymanager.js+premiummanager.js+qualitymanager.js+rejectedusernamesmanager.js+resizemanager.js+tutorialmanager.js+tutorial.js+purchasetutorial.js+accessoryequiptutorial.js+signuptutorial.js.pagespeed.jc.IoBHy-qIP4.js",
    
    # 后端和Ajax
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/ajax.js.pagespeed.jm.YCfeEYWKMr.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/backend.js.pagespeed.jm.QsQn1ymaYJ.js",
    
    # 游戏核心逻辑
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/constants.js+idgenerator.js+b2dutils.js+player.js+score.js.pagespeed.jc.2aEMG1TP37.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/emblem.js+maze.js+projectile.js+shrapnel.js+shotgun.js+homingmissile.js+trap.js.pagespeed.jc.GZ99Vrz609.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/mine.js+collectible.js+tank.js+weapon.js+bulletweapon.js+laserweapon.js+doublebarrelweapon.js+shotgunweapon.js+homingmissileweapon.js+mineweapon.js+gatlinggunweapon.js+upgrade.js+laseraimerupgrade.js+spawnshieldupgrade.js+aimerupgrade.js+shieldupgrade.js+speedboostupgrade.js+counter.js+timercountdowncounter.js+overtimecountupcounter.js+zone.js+spawnzone.js+stormzone.js+kill.js+trip.js+pickup.js+weapondeactivation.js+upgradeupdate.js+targetchange.js+victoryaward.js+playerkick.js+chickenout.js+shutdown.js+chatpost.js+systemchatpost.js+achievementunlock.js+playerupdate.js.pagespeed.jc.chxZpisqES.js",
    
    # 游戏控制器
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/gamecontroller.js+gamemodel.js.pagespeed.jc.qVj7z2um9h.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/roundcontroller.js.pagespeed.jm.or9CFx1Yb1.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/roundmodel.js+projectilestate.js+trapstate.js+collectiblestate.js+weaponstate.js+upgradestate.js+counterstate.js+zonestate.js+tankstate.js+playerstate.js+scorestate.js+emblemstate.js+inputstate.js+gamestate.js+roundstate.js.pagespeed.jc.2Z8LDDK8CD.js",
    
    # 消息系统
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/messageschemas.js+message.js+binarymessage.js+achievementunlockedmessage.js+handshakemessage.js+authenticatemessage.js+deauthenticatemessage.js+tankdestroyedmessage.js+tankkilledmessage.js+projectiletimeoutmessage.js+projectiledestroyedmessage.js+traptrippedmessage.js+trapdestroyedmessage.js+collectibledestroyedmessage.js+weapondestroyedmessage.js+upgradedestroyedmessage.js+counterdestroyedmessage.js+zonedestroyedmessage.js+pingmessage.js+pongmessage.js+resultmessage.js+binaryresultmessage.js+chatactivitymessage.js+globalchatmessage.js+chatmessage.js+userchatmessage.js+reportchatmessage.js+reportchatresultmessage.js+undochatreportmessage.js+undochatreportresultmessage.js+systemchatmessage.js+countdownmessage.js+gamestatemessage.js+joingamemessage.js+leavegamemessage.js+cancelleavegamemessage.js+listgamesmessage.js+requestmazemessage.js+roundendedmessage.js+roundcreatedmessage.js.pagespeed.jc.NQEBuYrrPB.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/celebrationstartedmessage.js+roundstartedmessage.js+roundstatemessage.js+stakesmessage.js+tankstatemessage.js+playerkickedmessage.js+playersbannedmessage.js+playersunbannedmessage.js+playerupdatedmessage.js+playerupdatedbyadminmessage.js+handshakeresultmessage.js+authenticateresultmessage.js+deauthenticateresultmessage.js+joingameresultmessage.js+leavegameresultmessage.js+cancelleavegameresultmessage.js+listgamesresultmessage.js+requestmazeresultmessage.js+creategameresultmessage.js+creategamemessage.js+gameendedmessage.js+shutdownmessage.js+contentupdatedmessage.js+messageparser.js+mazethememanager.js+gamemode.js+bootcampgamemode.js+classicgamemode.js+deathmatchgamemode.js.pagespeed.jc.ZPWKerrfnz.js",
    
    # AI系统
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/ais.js+aimanager.js+ai.js.pagespeed.jc.LsmNGKab1x.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/aiutils.js+mazemap.js+mathutils.js+arrayutils.js+ui,_uiconstants.js+ui,_uiutils.js+ui,_uipool.js.pagespeed.jc.KX9-nAxE6O.js",
    
    # UI核心
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/ui/uitankicon.js+uitankiconloader.js+uitankiconimage.js+uitankiconnamegroup.js+uirankicongroup.js+uiwaitingicongroup.js+uibuttongroup.js+uilaikaspine.js+uidimitrispine.js+scrapyard,_uibootstate.js+scrapyard,_uipreloadstate.js.pagespeed.jc.GhNGfgsH7f.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/ui/scrapyard,_uimainstate.js+scrapyard,_uiplateimage.js+playerpanel,_uiplayerpanel.js+playerpanel,_uibootstate.js+playerpanel,_uipreloadstate.js+playerpanel,_uimainstate.js+playerpanel,_uitankiconloginimage.js+playerpanel,_uirankiconsparkleimage.js+playerpanel,_uitankavatargroup.js+playerpanel,_uitankiconscoregroup.js+playerpanel,_uiscoreexplosionemitter.js+playerpanel,_uiscoreexplosionfragmentsprite.js+playerpanel,_uiscoreexplosionparticle.js+game,_uibootstate.js+game,_uipreloadstate.js.pagespeed.jc.aBh9sZ_mJ5.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/ui/game/uimenustate.js+uilobbystate.js.pagespeed.jc.hhZyiRY6zx.js",
    "cdn.tanktrouble.com/RELEASE-2026-05-11-01/js/tt/ui/game/uigamestate.js.pagespeed.jm.qMvwVpl8Pa.js",
]

def get_cache_path(url):
    """根据URL生成本地缓存路径"""
    from urllib.parse import urlparse
    parsed = urlparse(f"https://{url}")
    url_hash = hashlib.md5(url.encode('utf-8')).hexdigest()
    
    path = parsed.path
    ext = os.path.splitext(path)[1]
    if ext and len(ext) <= 10:
        filename = url_hash + ext
    else:
        filename = url_hash
    
    domain = parsed.netloc.replace('.', '_')
    cache_path = os.path.join(CACHE_DIR, domain, filename)
    
    return cache_path

def extract_core_files():
    """提取核心文件"""
    print("开始提取游戏核心文件...")
    
    # 创建目录结构
    os.makedirs("js", exist_ok=True)
    os.makedirs("css", exist_ok=True)
    os.makedirs("assets", exist_ok=True)
    
    # 复制核心JS文件
    for js_file in CORE_JS_FILES:
        cache_path = get_cache_path(js_file)
        if os.path.exists(cache_path):
            # 保持目录结构
            target_path = os.path.join("js", os.path.basename(js_file))
            with open(cache_path, 'rb') as f:
                content = f.read()
            with open(target_path, 'wb') as f:
                f.write(content)
            print(f"✓ 复制: {os.path.basename(js_file)}")
        else:
            print(f"[X] 未找到: {js_file}")
    
    # 复制CSS文件
    css_cache = os.path.join(CACHE_DIR, "cdn_tanktrouble_com", "470197018390ae7bcec6a199667c77e5.css")
    if os.path.exists(css_cache):
        with open(css_cache, 'rb') as f:
            content = f.read()
        with open("css/game.css", 'wb') as f:
            f.write(content)
        print("✓ 复制: game.css")
    
    # 复制jQuery CSS
    jquery_css_cache = os.path.join(CACHE_DIR, "code_jquery_com", "e68135fe1aaf9bd720e04bd4cd64b38d.css")
    if os.path.exists(jquery_css_cache):
        with open(jquery_css_cache, 'rb') as f:
            content = f.read()
        with open("css/jquery-ui.css", 'wb') as f:
            f.write(content)
        print("✓ 复制: jquery-ui.css")
    
    # 复制图片资源
    for img_file in ["817aa54ffd07b8669b680c2372ad5954.png", "9a16ac66e2c9d7d8ea38dd97233958f0.png", "f0c7a1ef7e1e424d6c6e4b5932ae82c7.png", "f90c1f7ba4c6deb8cd9ca76164145abf.png"]:
        img_cache = os.path.join(CACHE_DIR, "cdn_tanktrouble_com", img_file)
        if os.path.exists(img_cache):
            with open(img_cache, 'rb') as f:
                content = f.read()
            with open(f"assets/{img_file}", 'wb') as f:
                f.write(content)
            print(f"✓ 复制: {img_file}")
    
    print("\n核心文件提取完成！")

if __name__ == "__main__":
    extract_core_files()
