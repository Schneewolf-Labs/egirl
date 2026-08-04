import sys; sys.path.insert(0, '.')
from inventory import Store, Item, count_skus
s = Store(); s.add(Item('A', 'a', 1, 1.0)); s.add(Item('B', 'b', 1, 1.0))
assert count_skus(s) == 2, f"count_skus returned {count_skus(s)}"
print('ok')
