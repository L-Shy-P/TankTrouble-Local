# -*- coding: utf-8 -*-
"""
精准对比脚本：从原始CDN下载关键JS文件，与本地版本逐函数对比
重点：AI初始化流程、游戏流程、音量按钮、输入选择
"""
import os
import sys
import re
import urllib.request

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CDN_BASE = "https://cdn.tanktrouble.com/RELEASE-2026-05-11-01"
ORIGINAL_DIR = os.path.join(BASE_DIR, "original_js")
LOCAL_JS_DIR = os.path.join(BASE_DIR, "js")
LOCAL_INDEX = os.path.join(BASE_DIR, "index.html")

# 需要下载的原始组合JS文件URL（从original_backup.html中提取的关键文件）
CRITICAL_URLS = {
    # AI核心
    'ai_combined': f'{CDN_BASE}/js/tt/ais.js+aimanager.js+ai.js.pagespeed.jc.LsmNGKab1x.js',
    # AI工具
    'ai_utils': f'{CDN_BASE}/js/tt/aiutils.js+mazemap.js+mathutils.js+arrayutils.js+ui,_uiconstants.js+ui,_uiutils.js+ui,_uipool.js.pagespeed.jc.KX9-nAxE6O.js',
    # Backend
    'backend': f'{CDN_BASE}/js/backend.js.pagespeed.jm.QsQn1ymaYJ.js',
    # Ajax
    'ajax': f'{CDN_BASE}/js/ajax.js.pagespeed.jm.YCfeEYWKMr.js',
    # Content + main
    'content_main': f'{CDN_BASE}/js/shop.js+content.js+tt,_log.js+tt,_cache.js+tt,_ttclient.js+tt,_playerdetails.js+tt,_currency.js.pagespeed.jc.zL_8s75pck.js',
    # Inputs + Users + Caches
    'inputs_users': f'{CDN_BASE}/js/encoding,_textencoderlite.js+schemapack,_schemapack.min.js+adproviders,_adplacementadprovider.js+howler,_howler.core.min.js+main.js+caches.js+users.js+inputs.js.pagespeed.jc.JTTGjiZLXj.js',
    # SoundButton + MusicButton + SettingsButton
    'sound_music': f'{CDN_BASE}/js/settingsbox.js+chatbox.js+cookiebox.js+soundbutton.js+musicbutton.js+settingsbutton.js+buttongroup.js.pagespeed.jc.Kl86IIXCqm.js',
    # NewGameOverlay + AddUserBox + SelectUserBox + TankInfoBox
    'game_ui': f'{CDN_BASE}/js/errorbox.js+tankinfobox.js+adduserbox.js+selectuserbox.js+virtualshop.js.pagespeed.jc.lG0o28qscq.js',
    # Game states
    'game_states': f'{CDN_BASE}/js/tt/ui/game/uimenustate.js+uilobbystate.js.pagespeed.jc.hhZyiRY6zx.js',
    # Game state
    'game_uigamestate': f'{CDN_BASE}/js/tt/ui/game/uigamestate.js.pagespeed.jm.qMvwVpl8Pa.js',
    # GameController + GameModel
    'game_controller': f'{CDN_BASE}/js/tt/gamecontroller.js+gamemodel.js.pagespeed.jc.qVj7z2um9h.js',
    # RoundController
    'round_controller': f'{CDN_BASE}/js/tt/roundcontroller.js.pagespeed.jm.or9CFx1Yb1.js',
    # Garage overlay
    'garage': f'{CDN_BASE}/js/tt/ui/garage/uispraycanimage.js+uispraycanemitter.js+uispraycanparticle.js+uiscrollergroup.js+uiscrollerarrowimage.js+uiaccessoryimage.js+uiboximage.js+uiweldersmokeemitter.js+uiweldersmokeparticle.js+uiweldersparkemitter.js+uiweldersparkparticle.js.pagespeed.jc.Cdv6nJoj2g.js',
    # Garage boot + preload + main
    'garage_main': f'{CDN_BASE}/js/tt/ui/game,_uicountertimergroup.js+game,_uicounterovertimegroup.js+game,_uileavegamebuttongroup.js+game,_uicelebrationtrophygroup.js+game,_uistreamergraphics.js+game,_uiconfettiemitter.js+game,_uiconfettiparticle.js+game,_uitrophyexplosionemitter.js+game,_uitrophyexplosionparticle.js+game,_uitrophyexplosionfragmentsprite.js+garage,_uibootstate.js+garage,_uipreloadstate.js+garage,_uiloadstate.js+garage,_uimainstate.js+garage,_uigaragetankiconimage.js.pagespeed.jc.-BuDgAeWp2.js',
    # Overlays including garage, login, signup, newgame
    'overlays1': f'{CDN_BASE}/js/overlays/adminstatisticsoverlay.js+adminshopoverlay.js+adminvirtualshopitemdetailsoverlay.js+controlsoverlay.js+deleteaccountoverlay.js+faqoverlay.js+garageoverlay.js+loginoverlay.js+messagesoverlay.js+messageoverlay.js+newgameoverlay.js+newemailoverlay.js.pagespeed.jc.bCRosr1h3O.js',
    # Player panel
    'player_panel': f'{CDN_BASE}/js/tt/ui/scrapyard,_uimainstate.js+scrapyard,_uiplateimage.js+playerpanel,_uiplayerpanel.js+playerpanel,_uibootstate.js+playerpanel,_uipreloadstate.js+playerpanel,_uimainstate.js+playerpanel,_uitankiconloginimage.js+playerpanel,_uirankiconsparkleimage.js+playerpanel,_uitankavatargroup.js+playerpanel,_uitankiconscoregroup.js+playerpanel,_uiscoreexplosionemitter.js+playerpanel,_uiscoreexplosionfragmentsprite.js+playerpanel,_uiscoreexplosionparticle.js+game,_uibootstate.js+game,_uipreloadstate.js.pagespeed.jc.aBh9sZ_mJ5.js',
    # Tank icon
    'tank_icon': f'{CDN_BASE}/js/tt/ui/uitankicon.js+uitankiconloader.js+uitankiconimage.js+uitankiconnamegroup.js+uirankicongroup.js+uiwaitingicongroup.js+uibuttongroup.js+uilaikaspine.js+uidimitrispine.js+scrapyard,_uibootstate.js+scrapyard,_uipreloadstate.js.pagespeed.jc.GhNGfgsH7f.js',
    # Player + Score + Constants
    'player_score': f'{CDN_BASE}/js/tt/constants.js+idgenerator.js+b2dutils.js+player.js+score.js.pagespeed.jc.2aEMG1TP37.js',
    # MessageSchemas + AuthenticateResultMessage
    'messages': f'{CDN_BASE}/js/tt/messageschemas.js+message.js+binarymessage.js+achievementunlockedmessage.js+handshakemessage.js+authenticatemessage.js+deauthenticatemessage.js+tankdestroyedmessage.js+tankkilledmessage.js+projectiletimeoutmessage.js+projectiledestroyedmessage.js+traptrippedmessage.js+trapdestroyedmessage.js+collectibledestroyedmessage.js+weapondestroyedmessage.js+upgradedestroyedmessage.js+counterdestroyedmessage.js+zonedestroyedmessage.js+pingmessage.js+pongmessage.js+resultmessage.js+binaryresultmessage.js+chatactivitymessage.js+globalchatmessage.js+chatmessage.js+userchatmessage.js+reportchatmessage.js+reportchatresultmessage.js+undochatreportmessage.js+undochatreportresultmessage.js+systemchatmessage.js+countdownmessage.js+gamestatemessage.js+joingamemessage.js+leavegamemessage.js+cancelleavegamemessage.js+listgamesmessage.js+requestmazemessage.js+roundendedmessage.js+roundcreatedmessage.js.pagespeed.jc.NQEBuYrrPB.js',
    # Game modes + CreateGameResultMessage
    'game_modes': f'{CDN_BASE}/js/tt/celebrationstartedmessage.js+roundstartedmessage.js+roundstatemessage.js+stakesmessage.js+tankstatemessage.js+playerkickedmessage.js+playersbannedmessage.js+playersunbannedmessage.js+playerupdatedmessage.js+playerupdatedbyadminmessage.js+handshakeresultmessage.js+authenticateresultmessage.js+deauthenticateresultmessage.js+joingameresultmessage.js+leavegameresultmessage.js+cancelleavegameresultmessage.js+listgamesresultmessage.js+requestmazeresultmessage.js+creategameresultmessage.js+creategamemessage.js+gameendedmessage.js+shutdownmessage.js+contentupdatedmessage.js+messageparser.js+mazethememanager.js+gamemode.js+bootcampgamemode.js+classicgamemode.js+deathmatchgamemode.js.pagespeed.jc.ZPWKerrfnz.js',
    # Managers
    'managers1': f'{CDN_BASE}/js/utils.js+adminutils.js+achievementmanager.js+advertisementmanager.js+analyticsmanager.js+audiomanager.js+clientmanager.js+clipboardmanager.js+deletedemailsmanager.js+focusmanager.js.pagespeed.jc.tmsmWL21hw.js',
    'managers2': f'{CDN_BASE}/js/gamemanager.js+iframemanager.js+inputmanager.js+keyboardinputmanager.js+mouseinputmanager.js+overlaymanager.js+premiummanager.js+qualitymanager.js+rejectedusernamesmanager.js+resizemanager.js+tutorialmanager.js+tutorial.js+purchasetutorial.js+accessoryequiptutorial.js+signuptutorial.js.pagespeed.jc.IoBHy-qIP4.js',
}

def download_file(url, save_path):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Referer': 'https://tanktrouble.com/'
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            with open(save_path, 'wb') as f:
                f.write(data)
            return data.decode('utf-8', errors='ignore')
    except Exception as e:
        print(f"  [FAIL] {url}: {e}")
        return None

def search_in_local_js(keyword):
    """在本地JS文件中搜索关键词"""
    results = []
    if not os.path.exists(LOCAL_JS_DIR):
        return results
    for f in os.listdir(LOCAL_JS_DIR):
        if f.endswith('.js'):
            fpath = os.path.join(LOCAL_JS_DIR, f)
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as fh:
                    content = fh.read()
                if keyword in content:
                    # 找到关键词位置，提取上下文
                    idx = content.find(keyword)
                    start = max(0, idx - 100)
                    end = min(len(content), idx + 300)
                    results.append({
                        'file': f,
                        'context': content[start:end]
                    })
            except:
                pass
    return results

def search_in_index_html(keyword):
    """在本地index.html中搜索关键词"""
    if not os.path.exists(LOCAL_INDEX):
        return None
    with open(LOCAL_INDEX, 'r', encoding='utf-8') as f:
        content = f.read()
    if keyword in content:
        idx = content.find(keyword)
        start = max(0, idx - 100)
        end = min(len(content), idx + 300)
        return content[start:end]
    return None

def extract_mod_variable(content, var_name):
    """从pagespeed JS中提取mod变量内容"""
    pattern = rf'var {re.escape(var_name)}\s*=\s*"((?:[^"\\]|\\.)*)"'
    m = re.search(pattern, content)
    if m:
        return m.group(1).replace('\\"', '"').replace('\\n', '\n')
    return None

def main():
    print("=" * 70)
    print("精准对比：原始游戏 vs 本地修改版")
    print("=" * 70)
    
    # 步骤1: 下载关键原始文件
    print("\n[步骤1] 下载关键原始JS文件...")
    original_contents = {}
    for name, url in CRITICAL_URLS.items():
        filename = url.split('/')[-1]
        save_path = os.path.join(ORIGINAL_DIR, filename)
        
        if os.path.exists(save_path):
            print(f"  [CACHE] {name}")
            with open(save_path, 'r', encoding='utf-8', errors='ignore') as f:
                original_contents[name] = f.read()
        else:
            print(f"  [DOWNLOAD] {name}...")
            content = download_file(url, save_path)
            if content:
                original_contents[name] = content
                print(f"    OK ({len(content)} chars)")
            else:
                print(f"    FAILED")
    
    print(f"\n  成功获取 {len(original_contents)}/{len(CRITICAL_URLS)} 个原始文件")
    
    # 步骤2: 提取原始代码中的关键函数定义
    print("\n[步骤2] 分析原始代码中的关键函数...")
    
    # 合并所有原始代码
    all_original = ""
    for name, content in original_contents.items():
        all_original += content + "\n"
    
    # 关键函数列表
    critical_functions = {
        'AIs.init': 'AI初始化',
        'AIs.addAIManager': '添加AI管理器',
        'AIs.removeAIManager': '移除AI管理器',
        'AIs.update': 'AI更新',
        'AIs.getAvailableAIId': '获取可用AI ID',
        'AIManager.update': 'AI管理器更新',
        'AI.update': 'AI决策更新',
        'Backend.createGuests': '创建访客玩家',
        'Backend.getAIs': '获取AI列表',
        'Backend.getPlayerDetails': '获取玩家详情',
        'Backend.sprayPaint': '喷漆',
        'Backend.setColour': '设置颜色',
        'Content.init': '内容初始化',
        'Content.navigateToTab': '导航到标签页',
        'Game.UIMenuState': '游戏菜单状态',
        'Game.UILobbyState': '游戏大厅状态',
        'Game.UIGameState': '游戏状态',
        'SoundButton.init': '音量按钮初始化',
        'SoundButton._toggle': '音量切换',
        'SoundButton._on': '音量开启',
        'SoundButton._off': '音量关闭',
        'MusicButton.init': '音乐按钮初始化',
        'Inputs.getAllInputSetIds': '获取输入集ID',
        'NewGameOverlay': '新游戏覆盖层',
        'AddUserBox': '添加用户框',
        'SelectUserBox': '选择用户框',
        'TankInfoBox': '坦克信息框',
        'GarageOverlay': '车库覆盖层',
        'UIPlayerPanel': '玩家面板',
        'UITankIconImage': '坦克图标',
        'main(': '主函数',
    }
    
    print("\n[步骤3] 对比关键函数在原始和本地版本中的存在情况...")
    print("-" * 70)
    
    missing_critical = []
    for func_name, desc in critical_functions.items():
        in_original = func_name in all_original
        in_local_js = len(search_in_local_js(func_name)) > 0
        in_index = search_in_index_html(func_name) is not None
        
        status = ""
        if in_original and not in_local_js and not in_index:
            status = "!!! CRITICAL MISSING !!!"
            missing_critical.append((func_name, desc))
        elif in_original and in_local_js:
            status = "OK (local JS)"
        elif in_original and in_index:
            status = "PATCHED (in index.html)"
        elif not in_original:
            status = "N/A (not in downloaded originals)"
        
        print(f"  {desc} ({func_name}): {status}")
    
    # 步骤4: 深度分析AI流程
    print("\n[步骤4] 深度分析AI初始化和运行流程...")
    print("-" * 70)
    
    # 分析原始AIs.init
    if 'ai_combined' in original_contents:
        ai_content = original_contents['ai_combined']
        # 提取AIs.init的完整代码
        init_match = re.search(r'AIs\.classMethods\(\{(.+?)\}\);', ai_content, re.DOTALL)
        if init_match:
            init_code = init_match.group(1)
            print("\n  原始 AIs.classMethods 代码片段:")
            print("  " + init_code[:500] + "...")
    
    # 分析原始Backend.getAIs
    if 'backend' in original_contents:
        backend_content = original_contents['backend']
        getAIs_match = re.search(r'getAIs:function\((.+?)\}', backend_content)
        if getAIs_match:
            print("\n  原始 Backend.getAIs 代码:")
            print("  " + getAIs_match.group(0))
    
    # 分析原始Ajax.createGuests
    if 'ajax' in original_contents:
        ajax_content = original_contents['ajax']
        createGuests_match = re.search(r'createGuests:function\((.+?)\}', ajax_content)
        if createGuests_match:
            print("\n  原始 Ajax.createGuests 代码:")
            print("  " + createGuests_match.group(0))
    
    # 步骤5: 分析游戏流程 - 从点击1 Player到AI加入
    print("\n[步骤5] 分析游戏流程（1 Player -> AI加入）...")
    print("-" * 70)
    
    # 搜索NewGameOverlay
    if 'overlays1' in original_contents:
        overlay_content = original_contents['overlays1']
        # 搜索createGuests调用
        if 'createGuests' in overlay_content:
            idx = overlay_content.find('createGuests')
            print(f"\n  原始 NewGameOverlay 中 createGuests 调用:")
            print(f"  ...{overlay_content[max(0,idx-200):idx+300]}...")
    
    # 搜索Game.UILobbyState中AI相关代码
    if 'game_states' in original_contents:
        states_content = original_contents['game_states']
        if 'addAIManager' in states_content:
            idx = states_content.find('addAIManager')
            print(f"\n  原始 Game.UILobbyState 中 addAIManager 调用:")
            print(f"  ...{states_content[max(0,idx-200):idx+300]}...")
    
    # 步骤6: 检查本地index.html中的补丁是否正确
    print("\n[步骤6] 检查本地index.html补丁完整性...")
    print("-" * 70)
    
    if os.path.exists(LOCAL_INDEX):
        with open(LOCAL_INDEX, 'r', encoding='utf-8') as f:
            index_content = f.read()
        
        # 检查关键补丁
        patch_checks = [
            ('AIs.init', 'AI初始化补丁', True),
            ('AIs.update', 'AI更新循环补丁', True),
            ('AIs.addAIManager', 'AI管理器添加补丁', True),
            ('Backend.getInstance', 'Backend单例补丁', True),
            ('Backend.createGuests', '创建访客补丁', True),
            ('Backend.getAIs', '获取AI列表补丁', True),
            ('getPlayerDetails', '玩家详情补丁', True),
            ('requestAnimationFrame', '游戏循环补丁', True),
            ('SoundButton', '音量按钮补丁', False),
            ('AudioManager.toggleSound', '音量切换补丁', False),
            ('Inputs.getAllInputSetIds', '输入设置补丁', False),
            ('LoginOverlay', '登录覆盖层禁用', True),
            ('SignUpOverlay', '注册覆盖层禁用', True),
            ('messagesSnippet', '消息栏隐藏', True),
            ('GarageOverlay', '车库覆盖层补丁', False),
            ('TankInfoBox', '坦克信息框补丁', False),
            ('setColour', '设置颜色补丁', True),
            ('sprayPaint', '喷漆补丁', True),
        ]
        
        for patch_name, desc, required in patch_checks:
            if patch_name in index_content:
                print(f"  [OK] {desc} ({patch_name})")
            else:
                status = "[MISSING]" if required else "[OPTIONAL]"
                print(f"  {status} {desc} ({patch_name})")
    
    # 步骤7: 总结缺失项
    print("\n" + "=" * 70)
    print("总结：关键缺失项")
    print("=" * 70)
    
    if missing_critical:
        print(f"\n发现 {len(missing_critical)} 个关键缺失:")
        for func_name, desc in missing_critical:
            print(f"  - {desc} ({func_name})")
    else:
        print("\n所有关键函数在本地版本中都存在（可能在补丁中）")
    
    # 步骤8: 对比原始和本地的关键函数实现差异
    print("\n" + "=" * 70)
    print("步骤8: 关键函数实现对比")
    print("=" * 70)
    
    # 对比AIs.init
    print("\n--- AIs.init 对比 ---")
    print("原始版本: Backend.getInstance().getAIs(callback) -> AIs.ais[result[i].playerId] = result[i].config")
    local_ais_init = search_in_index_html('AIs.init')
    if local_ais_init:
        print(f"本地补丁: ...{local_ais_init[:200]}...")
    else:
        print("本地补丁: 未找到!")
    
    # 对比SoundButton
    print("\n--- SoundButton 对比 ---")
    if 'sound_music' in original_contents:
        sound_content = original_contents['sound_music']
        # 提取SoundButton完整代码
        sb_match = re.search(r'TankTrouble\.SoundButton=\{(.+?)\};', sound_content, re.DOTALL)
        if sb_match:
            sb_code = sb_match.group(0)
            print(f"原始 SoundButton 代码长度: {len(sb_code)} chars")
            # 关键：检查_on方法
            on_match = re.search(r'_on:function\((.+?)\}', sb_code)
            if on_match:
                print(f"原始 _on 方法: {on_match.group(0)}")
    
    local_sound = search_in_index_html('SoundButton')
    if local_sound:
        print(f"本地 SoundButton 补丁: ...{local_sound[:200]}...")
    else:
        print("本地 SoundButton: 未在index.html中找到补丁")
        # 检查本地JS
        local_sb = search_in_local_js('SoundButton')
        if local_sb:
            print(f"本地 JS 中 SoundButton 存在于: {local_sb[0]['file']}")
    
    print("\n\n分析完成!")

if __name__ == '__main__':
    main()
