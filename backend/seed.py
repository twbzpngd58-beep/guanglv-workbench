from .providers import uid


def empty_design():
    return dict(
        rooms=[],
        walls=[],
        openings=[],
        texts=[],
        fixtures=[],
        devices=[],
        scenes=[],
        palette="自然暖调",
        camera={
            "x": 0,
            "y": 0,
            "height": 1.6,
            "yaw": 0,
            "pitch": 0,
            "focal": 24,
            "ratio": "16:9",
            "resolution": "1920x1080",
        },
    )


def sample_design(variant=0):
    d = empty_design()
    specs = [
        ("客厅", 65, 65, 350, 275, 36, "#e6e3d8"),
        ("主卧", 430, 65, 265, 235, 26, "#dce5dc"),
        ("餐厅", 65, 355, 225, 195, 18, "#e8ded0"),
        ("厨房", 305, 355, 110, 195, 10, "#e0e4df"),
        ("次卧", 430, 315, 160, 235, 18, "#e1e4dc"),
        ("卫生间", 605, 315, 90, 145, 6, "#d6e2df"),
        ("阳台", 65, 565, 350, 60, 8, "#dee6cf"),
    ]
    for name, x, y, w, h, area, color in specs:
        r = dict(
            id=uid(),
            name=name,
            type=name,
            x=x,
            y=y,
            width=w,
            height=h,
            area=area,
            floor=1,
            heightM=2.8,
            color=color,
            source="example",
            notes="内置示例，不代表实际项目",
        )
        d["rooms"].append(r)
        for index, (dx, dy) in enumerate(
            [(0.27, 0.3), (0.72, 0.3), (0.27, 0.73), (0.72, 0.73)]
            if name in ["客厅", "主卧", "次卧"]
            else [(0.5, 0.5)]
        ):
            i = len(d["fixtures"]) + 1
            d["fixtures"].append(
                dict(
                    id=uid(),
                    code=f"L{i:03}",
                    name="防眩射灯" if i % 3 else "嵌入式筒灯",
                    type="射灯" if i % 3 else "筒灯",
                    beamAngle=24 if i % 3 else 60,
                    model="DL-07",
                    brand="示例产品",
                    roomId=r["id"],
                    floor=1,
                    x=x + w * dx,
                    y=y + h * dy,
                    installHeight=2.8,
                    power=7,
                    brightnessMax=100,
                    # 示例灯与手动布灯同口径，单色 3000K。
                    cct=3000,
                    cctMin=3000,
                    cctMax=3000,
                    colorMode="单色",
                    control="DALI",
                    circuit=f'C{1+len(d["rooms"]):02}',
                    dimmable=True,
                    tunable=False,
                    quote=True,
                    price=168,
                    priceVerified=False,
                    source="example",
                    notes="示例产品与价格，非正式报价",
                    length=1,
                    powerSupply="",
                    controller="",
                )
            )
    for name, bright, temp, fade in [
        ("全开", 100, 4000, 1),
        ("全关", 0, 3000, 1),
        ("日常照明", 85, 4000, 1),
        ("温馨会客", 65, 3000, 1),
        ("观影时光", 20, 2700, 1),
        ("晚安模式", 8, 2700, 1),
    ]:
        d["scenes"].append(
            dict(
                id=uid(),
                name=name,
                description="手动触发 · 全屋",
                trigger="手动",
                fade=fade,
                states={
                    # 单色 3000K 灯只能是 3000K：情景色温夹到灯具区间（否则保存校验越界）。
                    f["id"]: {"on": bright > 0, "brightness": bright,
                              "cct": min(max(temp, f["cctMin"]), f["cctMax"])}
                    for f in d["fixtures"]
                },
            )
        )
    return d
