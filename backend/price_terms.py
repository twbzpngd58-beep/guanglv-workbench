"""§5.2 四道闸③的词表正本：成本口径的词与字段名只在这里出现一次。

这个文件是**禁令词表**，不是金额计算——所以它本身被排除在闸③的 grep 之外，
这是闸③能成立的前提：要拦住这些词，总得先把它们写下来一次。
除本文件外，`backend/` 里任何模块出现下面这些词都算闸③失败（见
`tests/v3_brandwall_smoke.py`）；`backend/products.py` 的 DROP 是采集侧的排除清单，
属于「哪些列不许进库」，不是「金额从哪来」，测试里单独判它KEEP侧干净。
"""

# 结构上不允许存在的字段名（闸①②）
GATE1_FIELDS = ("cost_price", "dealer_price", "factory_price", "discount")  # §5.2 闸① 点名的四个
FIELD_TERMS = GATE1_FIELDS + ("cost", "wholesale_price", "purchase_price")

# 文案/备注里不允许出现的口径词（闸②③）。含旧价目表的折算系数标记。
CALIBER_TERMS = ("拿货价", "出厂价", "经销商价")  # §7.9 阶段 1 验收③ 点名的三个词
WORD_TERMS = CALIBER_TERMS + ("经销价", "批发价", "成本价",
                              "含运费出厂价", "预估运费", "75折", "×0.75")

# 闸③在 §5.2 正本里点名的两条 grep：旧价表的列名 + 旧价目表的折算系数
GATE3_PATTERNS = ("出厂价(元)", "×0.75")

# 旧报价表/价目表里必须挡在库外的列名（采集侧排除清单，见 products.py）
SRC_DROP_COLUMNS = ("出厂价(元)", "含运费出厂价(元)", "预估运费(元)", "备注", "灯具图片")
