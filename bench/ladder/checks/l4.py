import sys; sys.path.insert(0, '.')
from inventory import Store, Item
from inventory.report import low_stock
s = Store()
s.add(Item('B', 'b', 1, 1.0, reorder_level=2))
s.add(Item('A', 'a', 0, 1.0, reorder_level=0))
s.add(Item('C', 'c', 9, 1.0, reorder_level=1))
got = [i.sku for i in low_stock(s)]
assert got == ['A', 'B'], f"low_stock returned {got}, expected ['A','B']"
print('ok')
