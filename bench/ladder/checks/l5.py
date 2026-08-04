import sys; sys.path.insert(0, '.')
from inventory import Store, Item
from inventory.pricing import best_bundle
s = Store()
s.add(Item('A', 'a', 1, 6.0)); s.add(Item('B', 'b', 1, 5.0)); s.add(Item('C', 'c', 1, 5.0))
got = best_bundle(s, 10)
# greedy takes A(6) then can't fit either 5 -> ['A']; exact takes B+C = 10
assert got == ['B', 'C'], f"best_bundle returned {got}, expected ['B','C'] (greedy gives ['A'])"
print('ok')
