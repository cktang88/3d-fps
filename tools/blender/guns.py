"""Per-weapon source + normalisation specs for the FP rig pipeline.

Every source model is brought into the canonical gun frame (+X right, +Y muzzle, +Z up) at
GUN_K x real scale. `rot` is an XYZ euler (degrees) applied to the imported model; `length` is the
real overall length in metres measured along the bore over the parts that are kept (`drop` removes
duplicate/spare/cosmetic objects). `parts` maps contract roles to object-name regexes:
  Magazine        detachable magazine (moves during reloads)
  ChargingHandle  part that cycles when firing (slide / bolt carrier / charging handle / bolt)
  Pump            shotgun fore-end
  Glass           scope lenses (hidden in game; replaced by the PiP / overlay lens)
Sources are recorded in CREDITS (see docs/FP_FRAMING.md).
"""

SF = 'https://sketchfab.com/3d-models/'
GUNS = {
    'm4a1': dict(src='repo:public/assets/models/weapons/m4a1.glb', keep_nodes=True, length=0.84,
                 measure=r'^(M4A1Body_00|M4A1Body_01|StockGeometry)'),
    'ak47': dict(src='repo:public/assets/models/weapons/ak47.glb', keep_nodes=True, length=0.88, decimate=0.3,
                 measure=r'.*'),
    'scarl': dict(src='sf:g_scar/model.glb', rot=(0, 0, 0), length=0.889,
                  parts={'Magazine': r'^(Magazine|Mag\.002)', 'ChargingHandle': r'^Loader'},
                  credit=('FN Scar-L Assault Rifle', 'Hitansh_3DArtist', SF + 'fn-scar-l-assault-rifle-ea1823de59684fd596d9f6726382f948', 'CC-BY-4.0')),
    'mp5a5': dict(src='sf:g_mp5/model.glb', rot=(0, 0, 180), length=0.68,
                  parts={'Magazine': r'^Mag_low', 'ChargingHandle': r'^CH_low'},
                  credit=('MP5 Submachine Gun', 'Rotuma', SF + 'mp5-submachine-gun-a73b61932a0e4eecb5db5c63c158aa24', 'CC-BY-4.0')),
    'vss': dict(src='sf:g_vss/model.glb', rot=(0, 0, -90), length=0.894,
                parts={'Magazine': r'^Object_26$', 'Glass': r'^Glass'}, scope={'Rear': (-0.50, -0.47, 0.14), 'Front': (0.13, 0.165, 0.15)}, credit=('Special Sniper Rifle VSS Vintorez', 'ArmsMuseum', SF + 'special-sniper-rifle-vss-vintorez-4d5d8c1b7b79429abfa4816f18330089', 'CC0-1.0')),
    'm24': dict(src='sf:g_m24/model.glb', rot=(0, 0, 90), length=1.092,
                parts={'Glass': r'^Object_21$'},
                credit=('M24 Bounty Hunter Sniper Rifle', 'Naudaff3D', SF + 'm24-bounty-hunter-sniper-rifle-d40e74e2259549f5b025807163f1028c', 'CC-BY-4.0')),
    'awm': dict(src='sf:g_awm/model.glb', rot=(0, 0, -90), length=1.20,
                parts={'Magazine': r'^mag_', 'ChargingHandle': r'^(bolt_|bolt_handle)', 'Glass': r'^lenses'},
                credit=('AWM', 'erhanmatur', SF + 'awm-bacc05ad5c074c9daa3aa7ca02766a6c', 'CC-BY-4.0')),
    'p226': dict(src='sf:g_p226/model.glb', rot=(0, 0, 90), length=0.196,
                 parts={'Magazine': r'^Cargador', 'ChargingHandle': r'^(Carcasa|MirillaD|MT_Low)'},
                 credit=('Sig Sauer P226', 'Alexcanot', SF + 'sig-sauer-p226-e3d4f1ab22f342f4a0891743353c114c', 'CC-BY-4.0')),
    'm1911': dict(src='sf:g_m1911/model.glb', rot=(0, 0, 0), length=0.216, drop=r'(\.002|magazine_empty)',
                  parts={'Magazine': r'^(magazine_low|follower_low)', 'ChargingHandle': r'^(slide|extractor|firing_pin_stop|pin_firing|bushing|plunger_recoil|sight)'},
                  credit=('M1911 pistol', 'egorbelous', SF + 'm1911-pistol-80a0b8a6c4314da4a7b3a7cfe6cec1d4', 'CC-BY-4.0')),
    'shotgun': dict(src='sf:rem/model.glb', skinned=True, length=1.02, level=6.6,
                    parts={'Pump': r'^Slide$', 'Body': r'^(Body|Trig|Load)$', 'Shell': r'^12ge'},
                    credit=('FPS Arms remington (shotgun)', 'ccransh', SF + 'fps-arms-remington-shotgun-e68ef617fe8a48cca8610d016ffd5881', 'CC-BY-4.0')),
}

ARMS_CREDIT = [
    ('FPS AK-74m animations (rigged FP arms; grip template)', 'ccransh', SF + 'fps-ak-74m-animations-94be8385c402474cacd39bc096c6ca14', 'CC-BY-4.0'),
    ('Fps arms (arm mesh used by the ccransh rigs)', 'bumstrum (DJMaesen)', SF + 'fps-arms-9452ce4cddde4110a4fd73e555a8e412', 'CC-BY-4.0'),
    ('FPS pistol animations (pistol grip template)', 'ccransh', SF + 'fps-pistol-animations-0d7a343dcb6f401197a73c91aee93f6d', 'CC-BY-4.0'),
    ('FPS animations sniper rifle (bolt-gun grip template)', 'ccransh', SF + 'fps-animations-sniper-rifle-c15ae8393d824f5b929e3f69691cdd31', 'CC-BY-4.0'),
]
